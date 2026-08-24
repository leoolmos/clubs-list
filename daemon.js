#!/usr/bin/env node
/**
 * Racket club email collector — background daemon
 * =========================================================================
 * No API keys. No accounts. No billing. Nothing to sign up for.
 * This makes ordinary HTTP requests to public web pages, the same requests
 * your browser makes, and reads the emails clubs already publish.
 *
 *   node daemon.js              run forever, work a batch every hour
 *   node daemon.js once         one batch then exit  (for cron / launchd)
 *   node daemon.js status       progress report
 *   node daemon.js install      print the scheduler config for this machine
 *   node daemon.js seeds        show the seed list and its state
 *
 * Every tick resumes exactly where the last one stopped. Directory
 * pagination is bookmarked, crawled sites are marked, failures back off.
 * Nothing is ever fetched twice.
 *
 * Node 18+. Zero dependencies.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');

/* Anchored to the script, not the shell's working directory. A scheduler —
 * cron, launchd, Windows Task Scheduler — starts jobs from wherever it likes,
 * and with cwd the daemon would quietly build a second, empty database there. */
const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, 'data');
const DB_FILE   = path.join(DATA_DIR, 'clubs.json');        // working store, all fields
const QUEUE_FILE= path.join(DATA_DIR, 'queue.json');
const LOG_FILE  = path.join(DATA_DIR, 'daemon.log');
const CSV_FILE  = path.join(DATA_DIR, 'clubs-export.csv');
const SEEDS_FILE= path.join(ROOT, 'seeds.txt');
const APP_FILE  = path.join(ROOT, 'index.html');
const SITE_JSON = path.join(ROOT, 'clubs.json');            // what the page reads
const STATUS_JSON = path.join(ROOT, 'status.json');         // what the collector is doing
const STANDALONE_FILE = path.join(DATA_DIR, 'clubs-database.html');

const CFG = {
  tickMinutes:   parseInt(process.env.TICK_MINUTES   || '60', 10),  // how often
  budgetMinutes: parseInt(process.env.BUDGET_MINUTES || '20', 10),  // work per tick
  concurrency:   parseInt(process.env.CONCURRENCY    || '8',  10),
  hostDelayMs:   parseInt(process.env.HOST_DELAY_MS  || '2000',10), // per host
  pagesPerTick:  parseInt(process.env.PAGES_PER_TICK || '25', 10),
  // Five minutes. Eight bought nothing while Overpass answers the biggest
  // countries with 504s — the widened statements land whenever the mirrors
  // have a good hour, and the subdivision bookmarks carry across rounds.
  osmMinutes:    parseInt(process.env.OSM_MINUTES    || '5',  10),
  osmCountries:  parseInt(process.env.OSM_COUNTRIES  || '12', 10),  // countries per round
  // Two of the three Overpass mirrors publish no concurrency limit and the
  // third allows two per IP (see lib/osm.js). Six in flight spreads across
  // all three without queueing on the limited one. The ceiling is their
  // donated hardware, not this machine, so raising it a lot buys refusals
  // rather than speed.
  osmParallel:   parseInt(process.env.OSM_PARALLEL   || '6',  10),
  restSeconds:   parseInt(process.env.REST_SECONDS   || '20', 10),  // gap between rounds
  // Five seconds per page. A club site that has not answered in five is not
  // worth a worker's time when there are thousands of others waiting; it
  // comes round again in minutes.
  pageTimeoutMs: parseInt(process.env.PAGE_TIMEOUT_MS|| '5000', 10),
  retryMinutes:  parseInt(process.env.RETRY_MINUTES  || '10', 10),
  // Six minutes: the leads are all searched until their monthly retry, so
  // most rounds this is seconds — the slice matters again in September.
  leadMinutes:   parseInt(process.env.LEAD_MINUTES   || '6', 10),
  // The prospect-then-crawl chain is where the emails come from, so it
  // holds the largest slice of the round.
  // Eighteen of the twenty: the searching lane runs beside the reading
  // lane now (see tick), so this is the round, less the leads' turn.
  prospectMinutes: parseInt(process.env.PROSPECT_MINUTES || '18', 10),
  // The crawl used to take the whole round when the queue was long, and a
  // fresh pass over two thousand settled sites is exactly that. Twelve
  // minutes keeps the LTA register, the prospector and OpenStreetMap moving
  // while it works through the backlog a round at a time.
  crawlMinutes:    parseInt(process.env.CRAWL_MINUTES || '12', 10),
  // Giving the clubs that already have an address their city: one homepage
  // and one contact page each, a few minutes a round until they are placed.
  placeMinutes:    parseInt(process.env.PLACE_MINUTES || '3', 10),
  // The LTA register is 994 venues behind 100 listing pages, and at the
  // spacing this crawls at that is about half an hour of reading, once.
  // Six minutes a round walks it in a handful of rounds and then costs
  // nothing, because a walked register is marked done.
  ltaMinutes:      parseInt(process.env.LTA_MINUTES || '6', 10),
  // Curlie is volunteer-run and answers at 3s a page, so this is minutes of
  // walking rather than a page count worth tuning.
  discoverMinutes: parseInt(process.env.DISCOVER_MINUTES || '5',  10),
  discoverPages:   parseInt(process.env.DISCOVER_PAGES   || '60', 10),
  // Certificate-log mining: domains carrying a club word under the brief's
  // country TLDs, plus Wikidata's catalogued clubs. See lib/mine.js. Three
  // minutes, because the crt words refresh weekly and Wikidata backs off
  // for hours after a failed pass — most rounds this phase is seconds.
  mineMinutes:   parseInt(process.env.MINE_MINUTES || '3', 10),
  maxAttempts:   4
};

const { COUNTRIES, ccFromHost, isWanted } = require('./lib/countries');
const { detectSports, privateClub, extractEmails, extractContactName,
        plausibleSite, siteFromEmail, RE_PUBLIC, RE_PUBLIC_DOMAIN, RE_CLUBWORD } = require('./lib/classify');
const osm = require('./lib/osm');
const search = require('./lib/search');
const prospect = require('./lib/prospect');
const lta = require('./lib/lta');

/* Bumped when the questions or the vetting change enough that the answers
 * already on file were read through a worse lens. See phaseProspect.
 *   3: the contact word in every query now alternates between two spellings
 *      per language (lib/contact.js), so each city is asked a different set
 *      of questions than before — and is asked them all again.
 *   4: every query names the country in its own language beside the city
 *      ("clube de tênis Santos Brasil contato"), three terms a city instead
 *      of six, the engine asked at a gentler and less regular pace on two
 *      endpoints in turn, and the proof-of-place test knows Brasil as well
 *      as Brazil. Asked again from the first city. */
const QUERY_EPOCH = 4;
const mine = require('./lib/mine');
const discover = require('./discover');


const UA = 'RacketClubResearch/1.0 (club directory research; contact: set-your-email@example.com)';

/* ------------------------------------------------------------------ *
 * Polite fetching — per-host spacing, robots.txt, character sets      *
 * ------------------------------------------------------------------ */
const { sleep, links, hostOf, robotsAllow, isChallenge } = require('./lib/http');
const getPage = url => require('./lib/http').getPage(url, CFG.hostDelayMs, CFG.pageTimeoutMs);


function nextPage(html, base, seen){
  const rel = html.match(/<link[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
  if(rel){ try{ const u=new URL(rel[1],base).toString(); if(!seen.includes(u)) return u; }catch(e){} }
  for(const l of links(html, base)){
    if(/^(next|siguiente|siguiente »|próxima|proxima|seguinte|»|>|older|next page)$/i.test(l.text)){
      if(!seen.includes(l.url)) return l.url;
    }
  }
  return null;
}

function clubCandidates(html, base){
  const origin = new URL(base).origin;
  const out = new Map();
  for(const l of links(html, base)){
    const name = l.text;
    if(!name || name.length<4 || name.length>90) continue;
    if(!RE_CLUBWORD.test(name)) continue;
    if(RE_PUBLIC.test(name)) continue;
    if(/^(home|inicio|contacto|contact|about|login|registr|cookie|privac|terms|aviso|menu|buscar|search)/i.test(name)) continue;
    if(!out.has(name)) out.set(name, {name, url:l.url, internal:l.url.startsWith(origin)});
  }
  return Array.from(out.values());
}


/* Every external domain already present on the listing page is site chrome:
 * sponsors, the federation's own shop, the designer's credit, social links.
 * None is a club website. Without this, the first sponsor link on each club
 * page becomes that club's "website" — and since records are keyed by website
 * host, every club on the directory would collapse into a single record. */
function chromeDomains(html, base){
  const set = new Set();
  const origin = new URL(base).origin;
  for(const l of links(html, base)){
    if(l.url.startsWith(origin)) continue;
    const h = hostOf(l.url);
    if(h) set.add(h);
  }
  return set;
}

/* Pick the club's own site off its directory page.
 *
 * `clubName` is required, and the returned link has to look like it belongs
 * to that club. Taking the first outbound link instead handed clubs their
 * federation's sponsors — and a shared sponsor domain merged separate clubs
 * into one record, losing the rest. An empty string is the right answer far
 * more often than a guess is. */
function outboundSite(html, base, chrome, clubName){
  const origin = new URL(base).origin;
  const skip = /facebook|instagram|twitter|x\.com|youtube|linkedin|tiktok|whatsapp|google\.|maps\.|goo\.gl|wa\.me|t\.me|apple\.com|play\.google|wikipedia/i;
  for(const l of links(html, base)){
    if(l.url.startsWith(origin)) continue;
    if(skip.test(l.url)) continue;
    if(chrome && chrome.has(hostOf(l.url))) continue;
    if(clubName && !plausibleSite(clubName, l.url)) continue;
    if(/^https?:\/\//i.test(l.url)) return l.url.split('#')[0];
  }
  return '';
}

// Where a club keeps its address depends on the language its site is
// written in: Tenis Clube de Santos publishes secretaria@tcds.com.br on
// /fale-conosco/, a Spanish club on /contacto or /contactanos, an English one
// on /contact-us — and when none of those exists the legal or membership
// page usually prints one. The vocabulary lives in lib/contact.js, shared
// with the prospector; the crawl asks in the club's own language first.
const { contactPaths, linkTier } = require('./lib/contact');
const { cityIn } = require('./lib/place');

/* Pages read per site, the homepage included: the pages the site itself
 * names under a contact word, the sitemap's, the guessed paths in the
 * club's language, then the rest of the site. Thirty is enough to walk a
 * club site end to end; a site bigger than that is a federation or a
 * shop, and the address is on one of the first pages or nowhere. */
const CONTACT_PAGES = parseInt(process.env.CONTACT_PAGES || '30', 10);

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
function ensureDirs(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
function readJSON(f, fallback){
  if(!fs.existsSync(f)) return fallback;
  try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return fallback; }
}
/* Written beside the target and renamed over it, because a plain write is
 * not atomic and the working store is the only copy of everything collected.
 * A round writes it several times; a machine that sleeps, a container that
 * is reclaimed or a kill landing inside one of those writes would leave half
 * a file, and half a file does not parse — the whole database would read as
 * empty on the next start and the collector would begin again from nothing.
 * A rename cannot be caught halfway. */
function writeJSON(f, o){
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o,null,1));
  fs.renameSync(tmp, f);
}

/* ------------------------------------------------------------------ *
 * Activity log — the searched-for-what record
 * ------------------------------------------------------------------ *
 * The round log says "crawled 168 sites, +92 emails", which is a score, not
 * an account of what was done. This records each thing tried and how it
 * turned out, so the page can show the actual trail: this club was searched
 * for, that site was opened, this address came off that page.
 *
 * Kept to the most recent ACTIVITY_KEEP lines. It is a window on what is
 * happening, not an archive.
 */
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');
const ACTIVITY_KEEP = 400;

function activity(kind, text, extra){
  ensureDirs();
  const rec = Object.assign({t: new Date().toISOString(), kind, text}, extra||{});
  try{
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(rec)+'\n');
    // Trim occasionally rather than on every line
    if(Math.floor(Date.now()/1000) % 37 === 0) trimActivity();
  }catch(e){}
  return rec;
}

function trimActivity(){
  try{
    const lines = fs.readFileSync(ACTIVITY_FILE,'utf8').split(/\r?\n/).filter(Boolean);
    if(lines.length > ACTIVITY_KEEP*2){
      fs.writeFileSync(ACTIVITY_FILE, lines.slice(-ACTIVITY_KEEP).join('\n')+'\n');
    }
  }catch(e){}
}

function readActivity(n){
  try{
    const lines = fs.readFileSync(ACTIVITY_FILE,'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-(n||ACTIVITY_KEEP)).map(l=>{ try{ return JSON.parse(l); }catch(e){ return null; } }).filter(Boolean).reverse();
  }catch(e){ return []; }
}

function log(msg){
  ensureDirs();
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try{ fs.appendFileSync(LOG_FILE, line+'\n'); }catch(e){}
}

/* ------------------------------------------------------------------ *
 * One collector at a time
 * ------------------------------------------------------------------ *
 * "Only one may run at a time" has been in the README from the start, and
 * nothing enforced it. A second one was started here without stopping the
 * first, and the two of them cost eight clubs inside forty minutes: each
 * round reads the whole store into memory at the start and writes it back
 * at the end, so the slower one silently published its own stale copy over
 * everything the other had collected meanwhile. The count going backwards
 * was the only sign.
 *
 * start-collector.ps1 keeps a pid file, but only for the process it starts
 * itself; a plain `node daemon.js` walked straight past it. This is the
 * daemon refusing on its own behalf, whoever started it.
 */
const LOCK_FILE = path.join(DATA_DIR, 'collector.lock');

function lockHolder(){
  if(!fs.existsSync(LOCK_FILE)) return null;
  let held;
  try{ held = JSON.parse(fs.readFileSync(LOCK_FILE,'utf8')); }catch(e){ return null; }
  if(!held || !held.pid) return null;
  // Signal 0 asks whether the process exists without touching it, and works
  // the same on Windows. A lock left behind by a crash is not a lock.
  try{ process.kill(held.pid, 0); }catch(e){ return null; }
  return held;
}

function takeLock(cmd){
  ensureDirs();
  const held = lockHolder();
  if(held){
    console.error(`\n  Another collector is already running here (pid ${held.pid}, ${held.cmd},`);
    console.error(`  started ${held.at}).`);
    console.error(`\n  Two would fight over the same files: each round loads the store, works`);
    console.error(`  for its budget and writes the whole thing back, so the slower one undoes`);
    console.error(`  whatever the other collected in the meantime.`);
    console.error(`\n  Stop that one first, or delete ${LOCK_FILE} if it is not really there.\n`);
    return false;
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({pid: process.pid, cmd, at: new Date().toISOString()}, null, 1));

  // Give the lock back on the way out, however that happens. Without this a
  // Ctrl-C would leave a file that the pid check has to clean up after.
  const release = () => { try{
    const held = JSON.parse(fs.readFileSync(LOCK_FILE,'utf8'));
    if(held && held.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  }catch(e){} };
  process.on('exit', release);
  return true;
}

function keyFor(rec){
  if(rec.website){
    try{ return 'w:'+new URL(rec.website).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){}
  }
  return 'n:'+rec.cc+':'+String(rec.name).toLowerCase().replace(/[^a-z0-9]+/g,'');
}

const SEED_TEMPLATE = `# Seed directories — one per line:   COUNTRYCODE  URL
#
# Lines starting with # are ignored. Add as many as you like; the daemon
# works through them one page at a time and bookmarks its position, so a
# 200-page directory simply takes a few hours rather than one long run.
#
# What makes a good seed, richest first:
#   1. Booking platform club indexes      — best coverage for padel
#   2. National federation club lists     — tennis, padel and squash each have one
#   3. Regional federation lists          — in Spain these hold far more than the national body
#   4. Padel and tennis portals with club directories
#   5. League sites — a fixture list is a list of clubs with a secretary's email
#
# Find those pages in your browser, then paste the listing URL here.
# Example of the format (these are placeholders, replace them):
#
# ES  https://example-federacion.es/clubes
# PT  https://example-federacao.pt/clubes
# GB  https://example-directory.co.uk/clubs
# AR  https://example-padel.com.ar/clubes
`;

function loadSeeds(){
  if(!fs.existsSync(SEEDS_FILE)){
    fs.writeFileSync(SEEDS_FILE, SEED_TEMPLATE);
    log(`created ${SEEDS_FILE} — add directory URLs to it, then this will start collecting`);
    return [];
  }
  return fs.readFileSync(SEEDS_FILE,'utf8').split(/\r?\n/)
    .map(l=>l.trim())
    .filter(l=>l && !l.startsWith('#'))
    .map(l=>{
      // AUTO for a directory that spans countries — an international squash
      // index has clubs in thirty of them, and stamping one country on the
      // lot would give most of the records the wrong country and the wrong
      // language. With AUTO each club's country comes from its own domain.
      const m = l.match(/^(AUTO|[A-Za-z]{2})\s+(https?:\/\/\S+)$/i);
      return m ? {cc:m[1].toUpperCase(), url:m[2]} : null;
    })
    .filter(s=>s && (s.cc === 'AUTO' || COUNTRIES[s.cc]));
}

/* Merge seeds.txt into the persistent queue without losing bookmarks */
function syncQueue(){
  const q = readJSON(QUEUE_FILE, {});
  const seeds = loadSeeds();
  for(const s of seeds){
    if(!q[s.url]){
      q[s.url] = {cc:s.cc, url:s.url, nextPage:s.url, seenPages:[], pagesRead:0, done:false, added:new Date().toISOString().slice(0,10)};
    }
  }

  // A line taken out of seeds.txt has to leave the queue with it. This only
  // added, so deleting a bad seed did nothing: the queue kept its own copy
  // and went on walking it for ever. Six Curlie categories the brief
  // excludes — university and school squash, magazines, governing bodies —
  // were removed from the file and would have been walked anyway.
  //
  // Guarded on the file having parsed at all, because an unreadable or
  // half-written seeds.txt must not be read as "every seed was deleted".
  if(seeds.length){
    const wanted = new Set(seeds.map(s=>s.url));
    for(const url of Object.keys(q)) if(!wanted.has(url)) delete q[url];
  }

  writeJSON(QUEUE_FILE, q);
  return q;
}

/* ------------------------------------------------------------------ *
 * Work: crawl club sites that still lack an email
 * ------------------------------------------------------------------ */
/* Files and pages that never carry the club's address, and would only
 * spend the site's page budget: images, documents, feeds, the shop, the
 * login, the blog archive by month. Contact-word links are read whatever
 * their path; this only prunes the "other pages" tier. */
const RE_ASSET = /\.(jpe?g|png|gif|svg|webp|avif|bmp|ico|pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|mp[34]|m4a|mov|avi|webm|css|js|json|rss|woff2?|ttf|eot)(\?|#|$)/i;
const RE_NOISE = /\/wp-admin|\/wp-login|\/wp-json|\/xmlrpc|\/feed\/?(\?|$)|\/tag\/|\/etiqueta\/|\/category\/|\/categoria\/|\/page\/\d+|\/pagina\/\d+|[?&](p|page|paged|replytocom|share|add-to-cart|s|q|orderby|filter)=|\/cart|\/carrinho|\/carrito|\/checkout|\/login|\/logout|\/signin|\/register|\/registro|\/cadastro|\/my-account|\/minha-conta|\/mi-cuenta|\/author\/|\/autor\/|\/\d{4}\/\d{2}\/|\/galeria|\/gallery|\/fotos|\/photos|\/videos?\//i;

/* The part of a hostname that says whose site it is: club.com.br and
 * contato.club.com.br are one site, club.com.br and other.com.br are not. */
function siteKey(host){
  const p = String(host||'').toLowerCase().replace(/^www\./,'').split('.');
  if(p.length <= 2) return p.join('.');
  const sld = p[p.length-2];
  return (/^(co|com|org|net|gov|edu|ac|gob|nom|or|ne|art|esp)$/.test(sld) && p[p.length-1].length === 2)
    ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

function pageText(html){
  return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ')
                         .replace(/<style[\s\S]*?<\/style>/gi,' ')
                         .replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ');
}

/* The site's own map of itself, when it publishes one. Only the pages a
 * contact word describes are taken from it — a 2,000-URL sitemap is mostly
 * posts — and a sitemap index is followed one level, pages before posts. */
async function sitemapPages(origin, timeoutMs){
  const out = [];
  async function fetchXml(url){
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 6000);
    try{
      const r = await fetch(url, {headers:{'User-Agent':UA,'Accept':'application/xml,text/xml,*/*'}, redirect:'follow', signal:ctl.signal});
      if(!r.ok) return '';
      const buf = await r.arrayBuffer();
      if(buf.byteLength > 1500000) return '';
      return Buffer.from(buf).toString('utf8');
    }catch(e){ return ''; }
    finally{ clearTimeout(t); }
  }
  const locs = xml => Array.from(String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map(m => m[1].trim());

  let xml = await fetchXml(origin + '/sitemap.xml');
  if(!xml) xml = await fetchXml(origin + '/sitemap_index.xml');
  if(!xml) return out;

  let urls = locs(xml);
  if(/<sitemapindex/i.test(xml)){
    // pages first, posts last, and never more than three child maps
    const kids = urls.sort((a, b) => (/page/i.test(b) ? 1 : 0) - (/page/i.test(a) ? 1 : 0)).slice(0, 3);
    urls = [];
    for(const k of kids){
      const child = await fetchXml(k);
      if(child) urls = urls.concat(locs(child));
      if(urls.length > 3000) break;
    }
  }
  for(const u of urls){
    const tier = linkTier(u, '');
    if(tier >= 0 && tier <= 1) out.push({url: u, tier});
    if(out.length >= 30) break;
  }
  return out;
}

/* Time one site may take, however many pages it has: a slow host must not
 * hold a worker for the rest of the round. */
const SITE_MS = parseInt(process.env.SITE_MS || '150000', 10);

/**
 * Read a club's site for its address. The whole site, within reason, not a
 * list of guessed paths — the guesses missed every club whose contact page
 * is /atendimento-ao-socio, /the-club/contact, or a page the menu calls
 * "Fale com a gente" under a path nobody would guess.
 *
 *   1. the homepage, and its footer, which is where most clubs keep it
 *   2. every page the homepage links to that a contact word describes, in
 *      any of the three languages — contact pages first, then the club's
 *      about/members/where-we-are pages, then the legal small print
 *   3. the pages the sitemap lists under those same words
 *   4. the guessed paths, in the club's own language first
 *   5. the rest of the site's own pages, menu order, until the page budget
 *      or the clock runs out — and each page read adds the contact-word
 *      links it carries, so a contact page linked only from "About" is
 *      reached through "About"
 *
 * A site reachable only at the other scheme or without www is tried both
 * ways before it is called unreachable. A page with a contact form and no
 * address is noted as such — that club chose not to publish one, and the
 * page says so rather than "no email published" — and the city named on
 * the page that carried the address comes back with it, for the coverage
 * tab.
 */
async function harvestSite(website, lang, cc){
  let origin, host;
  try{ const u=new URL(website); origin=u.origin; host=u.hostname; }
  catch(e){ return {emails:[], note:'bad url'}; }

  // A Foursquare, Facebook or Wikipedia page is not the club's site, and
  // reading it end to end turns up Foursquare's address, not the club's.
  if(search.NOT_A_CLUB_SITE.test(website)) return {emails:[], contact:'', note:"not the club's own site"};

  const started = Date.now();
  const timeLeft = () => Date.now() - started < SITE_MS;

  let home = await getPage(origin);
  if(!home){
    // http <-> https, www <-> bare: a site that moved and did not redirect
    const alts = [];
    try{
      const u = new URL(origin);
      const other = u.protocol === 'https:' ? 'http:' : 'https:';
      const bare  = u.hostname.replace(/^www\./,'');
      const www   = /^www\./.test(u.hostname) ? u.hostname : 'www.' + u.hostname;
      for(const h of [u.hostname, /^www\./.test(u.hostname) ? bare : www]){
        for(const p of [u.protocol, other]){
          const o = p + '//' + h;
          if(o !== origin && !alts.includes(o)) alts.push(o);
        }
      }
    }catch(e){}
    for(const o of alts.slice(0, 3)){
      home = await getPage(o);
      if(home){ origin = o; host = new URL(o).hostname; break; }
    }
  }
  if(!home) return {emails:[], contact:'', note:'unreachable'};

  // A challenge page is not the club's site. Read as an ordinary page it
  // looks like a club with nothing on it — and "publishes no address" is
  // treated as settled, so each one was struck off after a single look.
  if(isChallenge(home)) return {emails:[], contact:'', note:'blocked by a challenge page'};

  const homeText = pageText(home);
  const cityOf = (text) => cityIn(cc, text) || cityIn(cc, homeText) || '';

  let emails = extractEmails(home, host);
  if(emails.length) return {emails, contact:extractContactName(home), note:'homepage', city: cityOf(homeText), pages: 1};

  const site = siteKey(host);
  const seen = new Set([origin.replace(/\/$/, ''), origin + '/']);
  const queue = [];                 // {url, tier, order}
  let order = 0;
  const add = (url, tier) => {
    let u;
    try{ u = new URL(url, origin); }catch(e){ return; }
    if(!/^https?:$/.test(u.protocol)) return;
    if(siteKey(u.hostname) !== site) return;
    u.hash = '';
    const key = u.toString().replace(/\/$/, '');
    if(seen.has(key)) return;
    if(RE_ASSET.test(u.pathname)) return;
    if(tier < 0 && RE_NOISE.test(u.pathname + u.search)) return;
    if(tier < 0 && u.search) return;          // other pages: no query strings
    seen.add(key);
    queue.push({url: u.toString(), tier: tier < 0 ? 3 : tier, order: order++});
  };

  // 1. the homepage's own links, every tier — "other pages" included, at
  //    the back of the queue
  for(const l of links(home, origin)) add(l.url, linkTier(l.url, l.text));
  // 2. the sitemap's contact-word pages
  for(const s of await sitemapPages(origin, CFG.pageTimeoutMs)) add(s.url, s.tier);
  // 3. the guesses, in the club's language — after the pages the site
  //    itself names (tiers 0 and 1), before the legal pages and the rest
  for(const p of contactPaths(lang, cc)) add(origin + p, 1.5);

  let formSeen = false, read = 1;
  while(queue.length && read < CONTACT_PAGES && timeLeft()){
    // the best page known right now: lowest tier, then the order it was found
    queue.sort((a, b) => a.tier - b.tier || a.order - b.order);
    const next = queue.shift();
    const html = await getPage(next.url);
    if(!html) continue;
    read++;
    if(isChallenge(html)) continue;

    emails = extractEmails(html, host);
    // On the contact and about pages any address is the club's. On the
    // legal pages and the rest of the site — a news post, an open-source
    // credit, a partner's write-up — only an address on the club's own
    // domain is: a gmail on a blog post belongs to whoever wrote the post.
    if(next.tier >= 2) emails = emails.filter(e => siteKey(e.split('@')[1] || '') === site);
    if(emails.length){
      const contact = extractContactName(html);
      let note = 'contact page';
      try{ note = new URL(next.url).pathname || '/'; }catch(e){}
      return {emails, contact, note, city: cityOf(pageText(html)), pages: read};
    }
    if(/<form\b[^>]*>[\s\S]*?(type\s*=\s*["']email["']|name\s*=\s*["'][^"']*e-?mail[^"']*["']|<textarea)/i.test(html)) formSeen = true;

    // 5. what this page links to, contact words only — depth two is where
    //    "About -> Contact the secretary" lives
    if(next.tier <= 1){
      for(const l of links(html, next.url)){
        const t = linkTier(l.url, l.text);
        if(t >= 0 && t <= 1) add(l.url, t);
      }
    }
  }
  return {emails:[], contact:'', note: formSeen ? 'contact form, no address' : 'no email published',
          city: cityOf(''), pages: read};
}

async function pool(items, limit, fn){
  const q = items.slice();
  await Promise.all(Array.from({length:Math.min(limit,q.length)}, async ()=>{
    while(q.length){
      const it = q.shift();
      try{ await fn(it); }catch(e){}
    }
  }));
}

/* Sites change. A club that published no address in June hires a new
 * secretary in July and puts one up. "Settled" therefore lasts a month, not
 * for ever: anything out of attempts gets one fresh look every thirty days. */
const SETTLED_REVIEW_MS = 30*24*60*60*1000;

/* Bumped when the crawl learns to find pages it used to walk past. "Publishes
 * no address" was settled by the old list of contact pages — one list, four
 * languages, eight fetches — and 1,543 sites were written off on its say-so.
 * The lens changed (lib/contact.js: the club's own language first, the
 * site's own links ranked, the legal and membership pages included), so
 * every settled site gets one fresh look, once, without waiting out the
 * month. Raise this when the crawl changes enough to deserve another. */
/*   3: the crawl reads the whole site — the pages the site itself names,
 *      the sitemap, depth two, thirty pages — instead of a list of guesses,
 *      and decodes more of the ways an address is hidden from a regex. */
const CRAWL_EPOCH = 3;

async function phaseCrawl(db, deadline){
  const today = Date.now();

  const epochFile = path.join(DATA_DIR, 'crawl-epoch.json');
  const epoch = readJSON(epochFile, {});
  if(epoch.crawl !== CRAWL_EPOCH){
    let again = 0;
    for(const r of Object.values(db)){
      if(r.email || !r.website) continue;
      if((r.attempts||0) < CFG.maxAttempts) continue;
      r.attempts = CFG.maxAttempts - 1;      // one look with the new list
      delete r.retryAfter;
      again++;
    }
    // The store first, then the marker: a restart between the two would
    // otherwise find the epoch already written and the sites still settled.
    writeJSON(DB_FILE, db);
    writeJSON(epochFile, {crawl: CRAWL_EPOCH, at: new Date().toISOString(), again});
    log(`crawl: reading ${again} settled sites again — the contact-page list changed (epoch ${CRAWL_EPOCH})`);
    activity('crawl', `reading ${again} settled sites again with the new contact-page list (epoch ${CRAWL_EPOCH})`, {ok:true});
  }

  for(const r of Object.values(db)){
    if(r.email || !r.website) continue;
    if((r.attempts||0) < CFG.maxAttempts) continue;
    if(!r.lastTried || today - Date.parse(r.lastTried) > SETTLED_REVIEW_MS){
      r.attempts = CFG.maxAttempts - 1;      // one look, then settled for another month
    }
  }
  const todo = Object.values(db).filter(r=>{
    if(r.email || !r.website) return false;
    if(r.attempts >= CFG.maxAttempts) return false;
    if(r.retryAfter && today < r.retryAfter) return false;
    return true;
  });
  if(!todo.length) return {tried:0, found:0};

  let tried=0, found=0, stopped=false;
  await pool(todo, CFG.concurrency, async rec=>{
    if(stopped || Date.now() > deadline){ stopped = true; return; }
    const {emails, contact, note, city} = await harvestSite(rec.website, rec.lang, rec.cc);
    tried++;
    rec.attempts = (rec.attempts||0)+1;
    rec.crawlNote = note;
    rec.lastTried = new Date().toISOString().slice(0,10);
    // The city the site names, for the coverage tab — whether or not an
    // address turned up, because the next round may find one.
    if(city && !rec.city) rec.city = city;
    if(emails.length){
      rec.email = emails[0];
      rec.alt = emails.slice(1,4);
      if(contact && !rec.contact) rec.contact = contact;
      rec.crawled = true;
      found++;
      activity('crawl', `${rec.name} — ${rec.website}${note==='homepage'?'':' '+note} -> ${rec.email}`,
               {ok:true, url:rec.website, email:rec.email});
    } else if(note === 'blocked by a challenge page'){
      // Not settled: the site exists and may well publish an address, we were
      // simply turned away. Try again later, and less often.
      activity('crawl', `${rec.name} — ${rec.website}: turned away by a captcha, will retry`, {ok:false, url:rec.website});
      rec.retryAfter = today + 6*60*60*1000;
      rec.attempts = Math.max(0, (rec.attempts||1) - 1);   // do not burn an attempt on a door we never got through
    } else if(note === 'no email published' || note === 'contact form, no address' || note === "not the club's own site"){
      activity('crawl', `${rec.name} — ${rec.website}: ` +
               (note === 'contact form, no address' ? 'site read, a contact form but no address'
                : note === "not the club's own site" ? 'not the club\'s own site, not read'
                : 'site read, publishes no address'),
               {ok:false, url:rec.website});
      rec.attempts = CFG.maxAttempts;         // settled, do not retry
      rec.crawled = true;
    } else {
      // Minutes, not days. This used to back off a full day per attempt, so
      // one timeout on a slow site froze it for twenty-four hours. With a
      // five-second budget per site a timeout means almost nothing — the
      // site was slow that second — and 152 sites ended up sitting out the
      // rest of the day while rounds reported "crawled 0 sites".
      rec.retryAfter = today + rec.attempts * CFG.retryMinutes*60*1000;
    }
  });
  return {tried, found};
}

/* ------------------------------------------------------------------ *
 * Work: advance one directory by a few pages
 * ------------------------------------------------------------------ */
async function phaseHarvest(db, queue, deadline){
  const pending = Object.values(queue).filter(s=>!s.done);
  if(!pending.length) return {pages:0, added:0, source:null};

  // least recently worked first, so directories advance evenly
  pending.sort((a,b)=>(a.lastRun||'').localeCompare(b.lastRun||''));

  // Keep taking seeds until the page budget or the clock runs out. Doing one
  // seed per tick sounded tidy and was hopeless in practice: a federation
  // that lists one province per URL is fifty-two separate seeds, none of
  // them paginated, so Spain alone would have taken fifty-two hours.
  let pages = 0, added = 0, worked = [];
  for(const seed of pending){
    if(pages >= CFG.pagesPerTick || Date.now() >= deadline) break;
    const r = await workSeed(seed, db, deadline, CFG.pagesPerTick - pages);
    pages += r.pages;
    added += r.added;
    if(r.pages) worked.push(new URL(seed.url).hostname);
  }

  return {pages, added, source: Array.from(new Set(worked)).join(', ') || null};
}

/* ------------------------------------------------------------------ *
 * Work: find new directories to walk
 * ------------------------------------------------------------------ *
 * The harvest above is the strongest engine there is, and it can only ever
 * be as good as seeds.txt. All 64 seeds are Spain, Ireland and Britain —
 * 52 Spanish ones produced 540 clubs, more than half the database — and
 * every one of them was found and pasted in by hand.
 *
 * discover.js has walked Curlie for new ones since the beginning, and it was
 * never wired to anything: it ran when somebody remembered to type it. So it
 * runs here, when the directories are exhausted and the harvest has nothing
 * left to do, which is exactly the state that used to end the round early.
 */
async function phaseDiscover(queue, deadline){
  if(process.env.DISCOVER === 'off') return {opened:0, found:0};

  // Only when there is nothing left to walk. A working seed is worth more
  // than the search for another one.
  const pending = Object.values(queue).filter(s=>!s.done);
  if(pending.length) return {opened:0, found:0, skipped:'seeds still working'};

  const budget = Math.min(deadline, Date.now() + CFG.discoverMinutes*60*1000);
  let r;
  try{ r = await discover.walk({max: CFG.discoverPages, deadline: budget, log: m => { const t = m.trim(); if(t) log('discover: '+t); }}); }
  catch(e){ log('discover failed: ' + e.message); return {opened:0, found:0}; }

  // New seed lines are only lines until the queue knows about them.
  if(r && r.found) syncQueue();
  return r || {opened:0, found:0};
}

/* ------------------------------------------------------------------ *
 * Work: search out the clubs of a country from nothing
 * ------------------------------------------------------------------ *
 * Sixty-two of the eighty-three countries hold no clubs at all. Neither of
 * the two engines that find them was ever aimed there: the directories are
 * three countries' worth, and the search only looks up names OSM has already
 * supplied — and OSM has almost none to give in those countries.
 *
 * This asks for a country's clubs directly, in its own language. The
 * candidates are vetted hard in lib/prospect.js, because a query with no
 * club name in it cannot be checked against one afterwards.
 */
/* ------------------------------------------------------------------ *
 * Work: the LTA's venue register
 * ------------------------------------------------------------------ *
 *
 * A national federation that publishes each venue's own email is the richest
 * source there is — Spain's RFET gave 330 addresses from 45 pages — and
 * Britain has one. lib/lta.js explains what is and is not allowed to be read
 * there; this is the slice of the round that reads it.
 *
 * It walks once. The register is bookmarked by page and by venue, so the
 * walk resumes where the round before it stopped, and a register walked to
 * the end costs nothing on every round after that.
 */
async function phaseLTA(db, deadline){
  if(process.env.LTA === 'off') return {pages:0, added:0, scanned:0};

  const st = readJSON(path.join(DATA_DIR, 'lta.json'), {page:1, seen:{}, done:false, added:0, refused:{}});
  if(st.done) return {pages:0, added:0, scanned:0, done:true};

  const knownHosts = new Set();
  for(const r of Object.values(db)){
    if(!r.website) continue;
    try{ knownHosts.add(new URL(r.website).hostname.replace(/^www\./,'').toLowerCase()); }catch(e){}
  }

  const budget = Math.min(deadline, Date.now() + CFG.ltaMinutes*60*1000);
  const r = await lta.importLTA({
    state: st, knownHosts, deadline: budget,
    timeoutMs: CFG.pageTimeoutMs + 4000, log: m => log(m)
  });

  let added = 0;
  for(const rec of r.added){
    const key = keyFor(rec);
    if(db[key]){
      // The register knows the address the club gave its federation, which is
      // worth having even when another engine found the site first.
      if(!db[key].email && rec.email) db[key].email = rec.email;
      if(!db[key].website && rec.website) db[key].website = rec.website;
      continue;
    }
    db[key] = rec;
    added++;
    activity('lta', `${rec.name}${rec.email ? ' -> ' + rec.email : ''}`, {ok:true, url:rec.website||rec.srcPage});
  }

  writeJSON(path.join(DATA_DIR, 'lta.json'), st);
  if(r.pages || added){
    log(`lta: ${r.pages} pages, ${r.scanned} venues read, ${added} clubs added (page ${st.page} of about 100)`);
    const top = Object.entries(st.refused || {}).sort((a,b)=>b[1]-a[1]).slice(0, 4);
    if(top.length) log(`lta: turned down — ` + top.map(([k,n])=>`${k} ×${n}`).join(', '));
  }
  return {pages:r.pages, added, scanned:r.scanned, done:!!st.done};
}

/* ------------------------------------------------------------------ *
 * Work: give the clubs that already have an address their city
 * ------------------------------------------------------------------ *
 * The coverage tab counts emails city by city, and only a record that
 * carries a city counts. Everything the crawl finds from now on arrives
 * with the city its contact page names; this is for the thousands found
 * before that — one look at the homepage and a contact page each, a few
 * minutes a round, until every placeable record is placed.
 */
async function phasePlace(db, deadline){
  if(process.env.PLACE === 'off') return {tried:0, placed:0};
  const budget = Math.min(deadline, Date.now() + CFG.placeMinutes*60*1000);
  const todo = Object.values(db).filter(r => r.email && r.website && !r.city && !r.placeTried);
  if(!todo.length) return {tried:0, placed:0, left:0};

  let tried = 0, placed = 0, stopped = false;
  await pool(todo, CFG.concurrency, async rec => {
    if(stopped || Date.now() > budget){ stopped = true; return; }
    tried++;
    rec.placeTried = new Date().toISOString().slice(0,10);
    let origin; try{ origin = new URL(rec.website).origin; }catch(e){ return; }
    const home = await getPage(origin);
    if(!home || isChallenge(home)) return;
    let city = cityIn(rec.cc, pageText(home));
    if(!city){
      // the contact page carries the address when the homepage does not
      const found = links(home, origin)
        .filter(l => l.url.startsWith(origin) && linkTier(l.url, l.text) === 0)
        .map(l => l.url.split('#')[0]).slice(0, 2);
      const pages = found.length ? found : contactPaths(rec.lang, rec.cc).slice(0, 2).map(p => origin + p);
      for(const u of pages){
        const html = await getPage(u);
        if(!html) continue;
        city = cityIn(rec.cc, pageText(html));
        if(city) break;
      }
    }
    if(city){ rec.city = city; placed++; }
  });
  const left = Object.values(db).filter(r => r.email && r.website && !r.city && !r.placeTried).length;
  if(tried) log(`place: read ${tried} sites for their city, ${placed} placed, ${left} left`);
  return {tried, placed, left};
}

async function phaseProspect(db, deadline){
  if(process.env.PROSPECT === 'off') return {countries:0, added:0};

  const stateFile = path.join(DATA_DIR, 'prospect.json');
  const state = readJSON(stateFile, {});

  /* Every query ever asked is remembered so none is paid for twice, which is
   * right until the asking itself improves. Three things changed at once: a
   * club whose title reads "Home - X" is no longer thrown away, tênis with a
   * circumflex is recognised as tennis at last, and Brazil is asked in its
   * own spelling. Together they mean the old answers were read through a
   * worse lens than the new ones would be — Tênis Clube de Santos ranked
   * first for its own city and was discarded on all three counts.
   *
   * So the ledger is torn up when the lens changes, once, and every city is
   * asked again. Raise this when the questions or the vetting change enough
   * to be worth another pass; leave it alone for anything smaller. */
  if(state.__epoch !== QUERY_EPOCH){
    const had = Object.keys(state).filter(k => !k.startsWith('__')).length;
    for(const k of Object.keys(state)){
      if(k.startsWith('__')) continue;
      state[k].queriesDone = [];
      state[k].cityStats = {};      // else every city counts its searches twice
    }
    state.__epoch = QUERY_EPOCH;
    writeJSON(stateFile, state);
    log(`prospect: searching every city again — ${had} countries, better vetting`);
    activity('prospect', `starting a fresh pass over every city (epoch ${QUERY_EPOCH})`, {ok:true});
  }

  // Every host already known, so a country is not re-vetted into a duplicate
  // of a club another engine found first.
  const knownHosts = new Set();
  for(const r of Object.values(db)){
    if(!r.website) continue;
    try{ knownHosts.add(new URL(r.website).hostname.replace(/^www\./,'').toLowerCase()); }catch(e){}
  }

  // Emptiest-first was right when sixty countries held nothing and a few
  // queries settled each one. With every city of 20,000 in the queue it
  // inverted: the slice drowned in Liberia and South Sudan — 96 searches
  // there, thirty-five for the whole United States — and the crawl starved.
  // So the rounds alternate: odd rounds walk the dense countries first
  // (PRIORITY is ordered by exactly that), even rounds take whoever has
  // waited longest, so no country is ever abandoned.
  let order, maxQ = 40;
  if(roundNo % 2 === 1){
    // The dense countries in turn — starting where the last odd round left
    // off, twelve queries each. Starting from the top every time meant
    // Spain ate every odd round until it was finished (1,680 queries) while
    // Brazil sat at forty and Santos was never reached; now each round
    // serves a few countries a modest helping and the next round serves
    // the next few.
    const PRIORITY = require('./lib/countries').PRIORITY;
    const cur = (state.__cursor || 0) % PRIORITY.length;
    order = PRIORITY.slice(cur).concat(PRIORITY.slice(0, cur)).map(cc => ({cc}));
    maxQ = 12;
  } else {
    order = Object.keys(COUNTRIES)
      .map(cc => ({cc, last: (state[cc]||{}).last || ''}))
      .sort((a,b) => a.last.localeCompare(b.last));
  }

  const budget = Math.min(deadline, Date.now() + CFG.prospectMinutes*60*1000);
  let countries = 0, added = 0, vetted = 0, served = 0;

  // Counted by kind, not by candidate: the reasons carry the site's own name
  // in them, and a hundred of those in the log is not a summary.
  const turnedDown = {};

  for(const {cc} of order){
    if(Date.now() > budget) break;

    const st = state[cc] || (state[cc] = {queriesDone:[], found:0});
    const r = await prospect.prospectCountry(cc, {
      knownHosts, deadline: budget, timeoutMs: CFG.pageTimeoutMs + 4000,
      queriesDone: st.queriesDone, deferred: st.deferred || [], maxQueries: maxQ, log: m => log(m)
    });

    st.queriesDone = r.queriesDone;
    st.deferred = r.deferred || [];
    st.last = new Date().toISOString();

    // Which cities were searched and what each produced, kept per country
    // so the coverage tab can show the trail city by city.
    if(r.perCity){
      st.cityStats = st.cityStats || {};
      for(const [city, v] of Object.entries(r.perCity)){
        const c = st.cityStats[city] || (st.cityStats[city] = {s:0, f:0});
        c.s += v.s; c.f += v.f;
      }
    }
    // The city named after its country is searched by the country-wide pass
    // and has no query set of its own. On a machine that asked those queries
    // before this landed they are already marked done, so nothing runs and
    // nothing would ever credit the city: Singapore, Hong Kong, Gibraltar and
    // Ilha de Mocambique would read nought searches for ever. Mirror the
    // country-wide count onto it — set, never added, so running it every
    // round settles on the right number instead of inflating it.
    const twin = prospect.twinCity(cc);
    if(twin && st.cityStats && st.cityStats['']){
      st.cityStats[twin] = {s: st.cityStats[''].s, f: (st.cityStats[twin] || {}).f || 0};
    }
    served++;                         // this country had its turn, cursor moves past it
    if(!r.queries) continue;          // every query already asked; move on
    countries++;
    vetted += r.candidates;

    for(const rec of r.added){
      const key = keyFor(rec);
      if(db[key]){
        if(!db[key].website) db[key].website = rec.website;
        continue;
      }
      db[key] = rec;
      added++;
      knownHosts.add(new URL(rec.website).hostname.replace(/^www\./,'').toLowerCase());
      activity('prospect', `${rec.country}: found ${rec.name} -> ${rec.website}`, {ok:true, url:rec.website});
    }
    st.found = (st.found||0) + r.added.length;
    for(const x of r.rejected){
      const kind = String(x.reason).replace(/ *"[^"]*"/, '').replace(/ to .*$/, '').trim();
      turnedDown[kind] = (turnedDown[kind]||0) + 1;
    }

    // The engine turning us away is not this country having no clubs, and
    // marking the queries done would write it off for good.
    if(r.throttled){
      log(`prospect: the search engine stopped answering (${r.throttleWhy || 'refused'}; gap now ${Math.round(search.currentGapMs()/1000)}s) — pausing this phase`);
      break;
    }
  }

  if(roundNo % 2 === 1 && served){
    state.__cursor = ((state.__cursor || 0) + served) % require('./lib/countries').PRIORITY.length;
  }
  writeJSON(stateFile, state);
  if(countries){
    log(`prospect: ${countries} countries searched, ${vetted} sites read, ${added} clubs added`);
    // A hundred sites read for two clubs is either the countries being
    // genuinely empty or a rule that is too tight, and the number on its own
    // cannot tell them apart. The same argument as status.json: a score is
    // not visibility. This is what to tune against.
    const top = Object.entries(turnedDown).sort((a,b)=>b[1]-a[1]).slice(0, 5);
    if(top.length) log(`prospect: turned down — ` + top.map(([r,n])=>`${r} ×${n}`).join(', '));
  }
  return {countries, added, vetted};
}

/* ------------------------------------------------------------------ *
 * Work: mine certificate logs and Wikidata for club domains
 * ------------------------------------------------------------------ *
 * The engines above can only find what somebody wrote down — in a
 * directory, on the map, in a search index's first page. A club's TLS
 * certificate is written down the moment its site goes up, whether or not
 * anyone ever lists it. lib/mine.js reads those logs.
 */
async function phaseMine(db, deadline){
  if(process.env.MINE === 'off') return {queried:0, vetted:0, added:0};
  const budget = Math.min(deadline, Date.now() + CFG.mineMinutes*60*1000);
  if(Date.now() >= budget) return {queried:0, vetted:0, added:0};
  try{
    return await mine.run(db, budget, m=>log(m));
  }catch(e){
    log('mine failed: ' + e.message);
    return {queried:0, vetted:0, added:0};
  }
}

/* Walk one directory for up to `budget` pages. */
async function workSeed(seed, db, deadline, budget){
  const auto = seed.cc === 'AUTO';
  const meta = auto ? null : COUNTRIES[seed.cc];
  if(!auto && !meta){ seed.done = true; seed.note = 'unknown country '+seed.cc; return {pages:0, added:0}; }
  let pages=0, added=0;

  while(seed.nextPage && pages < budget && Date.now() < deadline){
    const url = seed.nextPage;
    if(seed.seenPages.includes(url)){ seed.done = true; break; }

    const html = await getPage(url);
    if(!html){ seed.done = true; seed.note='page unreadable: '+url; break; }

    seed.seenPages.push(url);
    seed.pagesRead++;
    pages++;

    const pageEmails = extractEmails(html, new URL(url).hostname);
    const chrome = chromeDomains(html, url);

    // Addresses that belong to the directory rather than to any club: the
    // federation office, the regional officer, the webmaster. They sit in
    // the template, so they appear on every club's page too. Taking one
    // would give all 180 clubs in a region the same address — and the
    // export deduplicates on email, so 180 clubs would become one row.
    const dirHost = new URL(url).hostname.replace(/^www\./,'');
    const notClubEmail = e => e.endsWith('@'+dirHost) || pageEmails.includes(e);

    for(const c of clubCandidates(html, url)){
      if(Date.now() > deadline) break;
      const sports = detectSports(c.name);
      if(!sports.length) continue;

      let website='', email='';
      if(c.internal){
        const detail = await getPage(c.url);
        if(detail){
          website = outboundSite(detail, c.url, chrome, c.name);
          const f = extractEmails(detail, website ? new URL(website).hostname : '')
                      .filter(e => !notClubEmail(e));
          if(f.length) email = f[0];
        }
      } else {
        website = c.url;
      }
      if(!email && website && pageEmails.length){
        try{
          const host = new URL(website).hostname.replace(/^www\./,'');
          const m = pageEmails.find(e=>e.endsWith('@'+host));
          if(m) email = m;
        }catch(e){}
      }
      // The email's own domain is a better website than any link on the page,
      // because it cannot be a sponsor's.
      if(!website && email) website = siteFromEmail(email);

      // Second pass at the private-club rule, now that the website and any
      // email are known. The name check in clubCandidates cannot see either,
      // so a council venue with a neutral name only shows itself here.
      const verdict = privateClub({name:c.name, website, email});
      if(!verdict.ok) continue;

      // An AUTO seed spans countries, so each club's own domain decides.
      // A .com tells us nothing, and Language is a required field, so a
      // club we cannot place is dropped rather than guessed at.
      let cc = seed.cc, m = meta;
      if(auto){
        cc = ccFromHost(website) || ccFromHost(email.split('@')[1]||'');
        if(!cc || !isWanted(cc)) continue;
        m = COUNTRIES[cc];
      }

      const rec = {name:c.name, cc, country:m[0], lang:m[1], sports,
                   website, email, contact:'', src:'harvest', srcPage:url,
                   crawled: !!email, attempts:0};
      const k = keyFor(rec);
      if(db[k]){
        if(!db[k].email && rec.email){ db[k].email=rec.email; db[k].crawled=true; }
        if(!db[k].website && rec.website) db[k].website=rec.website;
        db[k].sports = Array.from(new Set(db[k].sports.concat(sports)));
      } else { db[k]=rec; added++; }
    }

    const np = nextPage(html, url, seed.seenPages);
    seed.nextPage = np;
    if(!np) seed.done = true;
  }

  seed.lastRun = new Date().toISOString();
  return {pages, added};
}

/* ------------------------------------------------------------------ *
 * Work: find websites for clubs we only know the name of
 * ------------------------------------------------------------------ *
 * OpenStreetMap knows about thousands more clubs than it holds contacts
 * for. Those were being kept as leads and otherwise ignored — 3,876 of them
 * sat in the file while the collector had nothing to do and every round
 * reported "crawled 0 sites".
 *
 * A club with no website is not a dead end, it is a search away from one.
 * On a sample of eight, seven were found in about two and a half seconds
 * each. Each one that resolves goes into the database with its website, and
 * the crawl picks the email off it.
 */
async function phaseLeads(db, deadline){
  if(process.env.LEADS === 'off') return {tried:0, found:0, emails:0};

  const leadsFile = path.join(DATA_DIR, 'osm-leads.json');
  const leads = readJSON(leadsFile, {});
  const keys = Object.keys(leads);
  if(!keys.length) return {tried:0, found:0, emails:0};

  const budget = Math.min(deadline, Date.now() + CFG.leadMinutes*60*1000);
  let tried=0, found=0, emails=0, throttled=0;

  // A lead searched once is not settled for ever either: rankings move and
  // new club sites appear. One fresh search a month, websites excepted.
  const LEAD_RETRY_MS = 30*24*60*60*1000;

  for(const k of keys){
    if(Date.now() > budget) break;
    const lead = leads[k];
    if(!lead) continue;
    if(lead.searched){
      if(lead.website) continue;
      if(Date.now() - Date.parse(lead.searched) < LEAD_RETRY_MS) continue;
    }

    tried++;
    let r;
    try{ r = await search.findClubSite(lead, CFG.pageTimeoutMs + 3000); }
    catch(e){ r = {url:'', queries:[], note:'search failed: '+e.message, throttled:true}; }

    // A club is only "searched" when the engine actually answered. Marking
    // one searched after a refusal is how 3,685 clubs were written off in a
    // single pass while their websites sat there waiting to be found.
    if(r.throttled){
      throttled++;
      lead.searchNote = r.note;
      activity('search', `${lead.name}: search engine did not answer, will try again`, {ok:false});
      // Several in a row means it is us being turned away, not these clubs.
      // Stop and give the time back; the leads keep their place in the queue.
      if(throttled >= 4){
        log(`leads: the search engine stopped answering after ${tried} queries — pausing this phase`);
        break;
      }
      await sleep(4000);
      continue;
    }
    throttled = 0;

    lead.searched = new Date().toISOString();
    lead.searchNote = r.note;

    if(!r.url){
      activity('search', `no site found for ${lead.name} (${lead.country})`, {ok:false});
      continue;
    }

    found++;
    lead.website = r.url;

    // Straight on to the email while we are here, rather than leaving it for
    // a later round — the whole point is to convert a name into a contact.
    const {emails:found_, contact, note, city} = await harvestSite(r.url, lead.lang, lead.cc);
    const email = found_.length ? found_[0] : '';

    const rec = {
      name: lead.name, cc: lead.cc, country: lead.country, lang: lead.lang,
      sports: lead.sports, website: r.url, email,
      contact: contact || lead.contact || '',
      src: 'search', srcPage: lead.srcPage || '',
      // the town OpenStreetMap recorded, if it is a listed city, else the
      // one the site names
      city: cityIn(lead.cc, lead.town || '') || city || '',
      crawled: !!email, attempts: email ? 0 : 1,
      crawlNote: note
    };

    // Only the domain is re-checked here, not the name. The lead already
    // passed the private-club rules when OpenStreetMap produced it, and
    // re-running the name test threw away good finds: "Tenis Pontevedra"
    // was rejected for having no club word in it, seconds after its own
    // site — clubdetenispontevedra.es — had been found and matched.
    if(RE_PUBLIC_DOMAIN.test(r.url) || (email && RE_PUBLIC_DOMAIN.test(email.split('@')[1]||''))){
      activity('search', `${lead.name} -> ${r.url}, dropped: public or institutional domain`, {ok:false});
      continue;
    }

    const key = keyFor(rec);
    if(db[key]){
      if(!db[key].email && email){ db[key].email = email; db[key].crawled = true; emails++; }
      if(!db[key].website) db[key].website = r.url;
    } else {
      db[key] = rec;
      if(email) emails++;
    }

    activity('search', email
      ? `${lead.name} (${lead.country}) -> ${r.url} -> ${email}`
      : `${lead.name} (${lead.country}) -> ${r.url}, no address on the site (${note})`,
      {ok: !!email, url: r.url, email});
  }

  writeJSON(leadsFile, leads);
  const left = Object.values(leads).filter(l=>!l.searched).length;
  if(tried) log(`leads: searched ${tried}, found ${found} sites, ${emails} new emails, ${left} leads left`);
  return {tried, found, emails, left};
}

/* ------------------------------------------------------------------ *
 * Work: pull one country from OpenStreetMap
 * ------------------------------------------------------------------ *
 * The seeds file can only cover countries that have a federation publishing
 * a crawlable club list. Most of the ninety do not. This walks the country
 * list instead, one per tick, and never repeats one until every other has
 * had a turn.
 */
async function phaseOSM(db, deadline){
  if(process.env.OSM === 'off') return {cc:null, added:0};
  // Needs a few minutes of headroom; a country cut off halfway would be
  // marked done and silently under-collected.
  if(Date.now() > deadline - 4*60*1000) return {cc:null, added:0, skipped:'no time left'};

  // OSM gets a slice of the round, not the remainder of it. Discovery is
  // useless on its own — a club with a website and no email is not a
  // result — and the crawl is what turns one into the other. The round
  // that imported the UK spent 36 of its 37 minutes in Overpass and
  // crawled eight sites, leaving 207 clubs sitting in the queue.
  const osmDeadline = Math.min(deadline, Date.now() + CFG.osmMinutes*60*1000);

  const codes = osm.nextCountries(CFG.osmCountries);
  if(!codes.length) return {cc:null, added:0};

  try{
    const results = await osm.importMany(codes, db, m=>log(m), osmDeadline, CFG.osmParallel);
    const ok = results.filter(r=>!r.error);
    const added = ok.reduce((n,r)=>n+(r.added||0), 0);
    return {cc: codes.join(','), added, countries: ok.length, failed: results.length-ok.length};
  }catch(e){
    log(`osm threw: ${e.message}`);
    return {cc: codes.join(','), added:0, error:e.message};
  }
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */
function csvCell(v){ const s=String(v==null?'':v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function writeExport(db){
  const rows = publishable(db);
  const lines = rows.map(r=>[r.name, r.sports.join('+'), r.contact||'', r.email, r.country].map(csvCell).join(','));
  fs.writeFileSync(CSV_FILE, lines.join('\n'));
  return rows.length;
}

/* The public view of a record. A club only counts once it has the four things
 * that were asked for — name, sport, email, language — so anything short of
 * that stays in the working store and out of the published file. */
function publishable(db){
  const rows = Object.values(db)
    .filter(r => r.name && r.email && r.lang && r.sports && r.sports.length)
    .map(r => ({name:r.name, sports:r.sports.slice(), contact:r.contact||'', email:String(r.email).toLowerCase(),
                lang:r.lang, country:r.country, src:r.src, stale:!!r.stale}));

  // One row per address. Records are keyed by website in the store, so the
  // same club found through a federation list and through OSM sits under two
  // keys until it has an email — after which both carry the same address and
  // the export would show it twice.
  const byEmail = new Map();
  const shared  = new Map();
  for(const r of rows){
    const seen = byEmail.get(r.email);
    if(!seen){ byEmail.set(r.email, r); shared.set(r.email, 1); continue; }
    shared.set(r.email, shared.get(r.email)+1);
    seen.sports  = Array.from(new Set(seen.sports.concat(r.sports)));
    if(!seen.contact && r.contact) seen.contact = r.contact;
    if(seen.name.length < r.name.length) seen.name = r.name;   // prefer the fuller name
  }

  // One address on a handful of clubs is a small chain. One address on
  // dozens is a directory's own office address that leaked through, and
  // publishing it would put a federation's inbox under some arbitrary club's
  // name. Drop those and say so rather than shipping a wrong row.
  for(const [email, n] of shared){
    if(n > 5){
      byEmail.delete(email);
      log(`dropped ${email} — claimed by ${n} different clubs, so it belongs to a directory, not a club`);
    }
  }

  return Array.from(byEmail.values())
    .sort((a,b)=>a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ *
 * status.json — what the collector is doing, and why the number is not
 * moving
 * ------------------------------------------------------------------ *
 * A club count on its own is not visibility. It sat at 589 for hours while
 * the collector was working the whole time: every Overpass query was being
 * refused, and every site in the crawl queue was inside its retry backoff.
 * Both are ordinary states, and neither was visible, so the only honest
 * reading from outside was "it is broken".
 *
 * Written at the start and end of every round and after each phase, so the
 * page can say what is happening right now rather than what happened last.
 */
function writeStatusJSON(extra){
  const db    = readJSON(DB_FILE, {});
  const queue = readJSON(QUEUE_FILE, {});
  const osmState = readJSON(path.join(DATA_DIR,'osm-state.json'), {});
  const now = Date.now();

  const all = Object.values(db);
  const noEmail = all.filter(r => !r.email && r.website);

  const crawl = {
    ready:     noEmail.filter(r => (r.attempts||0) < CFG.maxAttempts && !(r.retryAfter && now < r.retryAfter)).length,
    waiting:   noEmail.filter(r => r.retryAfter && now < r.retryAfter).length,
    exhausted: noEmail.filter(r => (r.attempts||0) >= CFG.maxAttempts).length
  };

  // Why sites were given up on, which is the difference between "the crawler
  // is broken" and "these clubs do not publish an address"
  const reasons = {};
  for(const r of all){ if(r.crawlNote) reasons[r.crawlNote] = (reasons[r.crawlNote]||0) + 1; }
  const topReasons = Object.entries(reasons).sort((a,b)=>b[1]-a[1]).slice(0,6);

  const seeds = Object.values(queue);
  const countries = require('./lib/countries').PRIORITY;
  const osm = {
    imported: countries.filter(cc => osmState[cc] && !osmState[cc].error).length,
    failed:   countries.filter(cc => osmState[cc] && osmState[cc].error).length,
    pending:  countries.filter(cc => !osmState[cc]).length,
    total:    countries.length,
    lastError: (()=>{
      const errs = countries.filter(cc=>osmState[cc] && osmState[cc].error)
        .sort((a,b)=>String(osmState[b].at||'').localeCompare(String(osmState[a].at||'')));
      return errs.length ? {cc: errs[0], error: osmState[errs[0]].error, at: osmState[errs[0]].at} : null;
    })()
  };

  /* Per country, what has actually been done to it.
   *
   * Clicking a country used to open a form for typing notes by hand, which
   * nobody ever filled in, so every country showed the same blank example.
   * All of this is already known — it just was not being written down. */
  const leadsAll = Object.values(readJSON(path.join(DATA_DIR,'osm-leads.json'), {}));
  const seedsAll = Object.values(queue);
  const perCountry = {};

  function slot(country){
    if(!country) return null;
    return perCountry[country] || (perCountry[country] = {
      clubs:0, emails:0, sites:0, read:0, unreachable:0, noAddress:0,
      leads:0, leadsSearched:0, leadsFound:0,
      sports:{Tennis:0, Padel:0, Squash:0},
      sources:{}, seeds:0, osm:null
    });
  }

  for(const r of all){
    const s = slot(r.country); if(!s) continue;
    s.clubs++;
    if(r.email){ s.emails++; s.sources[r.src||'?'] = (s.sources[r.src||'?']||0)+1; }
    if(r.website) s.sites++;
    if(r.crawlNote){
      s.read++;
      if(r.crawlNote === 'unreachable') s.unreachable++;
      else if(r.crawlNote === 'no email published') s.noAddress++;
    }
    for(const sp of r.sports||[]) if(sp in s.sports) s.sports[sp]++;
  }
  for(const l of leadsAll){
    const s = slot(l.country); if(!s) continue;
    s.leads++;
    if(l.searched) s.leadsSearched++;
    if(l.website)  s.leadsFound++;
  }
  for(const sd of seedsAll){
    const s = slot(require('./lib/countries').nameOf(sd.cc)); if(!s) continue;
    s.seeds++;
  }
  for(const cc of countries){
    const st = osmState[cc];
    if(!st) continue;
    const s = slot(require('./lib/countries').nameOf(cc)); if(!s) continue;
    s.osm = {at: st.at, seen: st.seen, added: st.added, rejected: st.rejected,
             error: st.error || null, via: st.via || ''};
  }

  /* Which searches the prospector runs for each country, and how far it
   * has got — so the page can show the actual city list rather than a
   * number. Every country gets a slot, even one nothing has reached. */
  const prospectState = readJSON(path.join(DATA_DIR, 'prospect.json'), {});
  const prospectLib = require('./lib/prospect');

  // Emails captured per city: a prospect record remembers which city's
  // search surfaced it, and the crawl fills the email in later. Counted
  // from the store each time, so the number is always the current truth.
  const cityEmails = {};
  for(const r of all){
    if(!r.city || !r.email || !r.country) continue;
    const bag = cityEmails[r.country] || (cityEmails[r.country] = {});
    bag[r.city] = (bag[r.city] || 0) + 1;
  }

  for(const [cc, [cname, clang]] of Object.entries(COUNTRIES)){
    const s = slot(cname); if(!s) continue;
    const cities = prospectLib.CITIES[cc] || [];
    const terms = prospectLib.termsFor(cc, clang);
    // The city named after its own country is searched by the country-wide
    // pass, not by a set of its own, so its terms are not a separate target.
    // Counting them made four countries permanently six searches short.
    const total = terms.length * (1 + cities.length - (prospectLib.twinCity(cc) ? 1 : 0));
    const pst = prospectState[cc] || {};
    const done = (pst.queriesDone || []).length;
    const cs = pst.cityStats || {};
    // Union of the cities searched and the cities holding emails: the
    // backfilled records sit in cities the prospector has not reached yet,
    // and their emails must show all the same.
    const merged = new Map(
      Object.entries(cs).filter(([k]) => k !== '')
        .map(([n, v]) => [n, {s: v.s, f: v.f, e: (cityEmails[cname] || {})[n] || 0}])
    );
    for(const [n, e] of Object.entries(cityEmails[cname] || {})){
      if(!merged.has(n)) merged.set(n, {s: 0, f: 0, e});
    }
    // Biggest city first, the order the prospector works in and the order
    // the page prints, so the rows diff quietly from one round to the next.
    const rank = new Map(cities.map((n, i) => [n, i]));
    const cityRows = Array.from(merged)
      .sort((a, b) => (rank.has(a[0]) ? rank.get(a[0]) : 1e9) - (rank.has(b[0]) ? rank.get(b[0]) : 1e9)
                   || a[0].localeCompare(b[0]));
    s.prospect = {
      // the coverage tab joins this back to lib/cities.json by country code
      cc,
      // the first thirty planned cities are enough for the modal; the full
      // list would put 2,000 chips in it for Brazil alone
      cities: cities.slice(0, 30), citiesTotal: cities.length,
      citiesSearched: Object.keys(cs).filter(k => k !== '').length,
      searchesDone: Math.min(done, total), searchesTotal: total,
      found: Object.values(cs).reduce((n, v) => n + (v.f || 0), 0),
      emails: Object.values(cityEmails[cname] || {}).reduce((n, e) => n + e, 0),
      countrywide: cs[''] || null,
      // Every city that has been searched, not a top slice of them. The cap
      // used to be 400 rows ranked by emails, and the page prints all of a
      // country's cities and reads a missing row as nought searches — so the
      // 502 quietest Brazilian cities, already searched and simply low
      // yielding, were shown as untouched, and the marker for where the
      // scraper stands landed on the first city the cap had dropped.
      // The row shape stays as it is, deliberately. A compact [name, count]
      // pair costs seventeen bytes against thirty-seven and would have paid
      // for the extra rows outright — but the page reading these is whatever
      // GitHub Pages last served, and it cannot be updated in the same
      // breath: index.html is one of the files publish.js keeps, so the
      // running collector restores its own copy and a page pushed from
      // elsewhere never reaches the site until that collector is restarted.
      // Uncapping alone fixes what readers actually see, and it does it
      // through every old page as well as every new one. 6,638 rows in
      // 236 KB before, 7,844 in 279 KB now, near 551 KB at full coverage —
      // the compact shape is worth having later, with the page beside it.
      cityStats: cityRows.map(([n, v]) => ({n, s: v.s, f: v.f, e: v.e})),
      last: pst.last || null
    };
  }

  let recent = [];
  try{
    recent = fs.readFileSync(LOG_FILE,'utf8').split(/\r?\n/).filter(Boolean).slice(-14);
  }catch(e){}

  const status = Object.assign({
    generated: new Date().toISOString(),
    clubs:     publishable(db).length,
    records:   all.length,
    crawl, osm,
    crawlReasons: topReasons.map(([note,n])=>({note, n})),
    seeds: {
      total:     seeds.length,
      working:   seeds.filter(s=>!s.done).length,
      exhausted: seeds.filter(s=>s.done).length,
      pagesRead: seeds.reduce((n,s)=>n+(s.pagesRead||0), 0)
    },
    leads: (()=>{ const L=readJSON(path.join(DATA_DIR,'osm-leads.json'), {}); const v=Object.values(L);
      return {total:v.length, searched:v.filter(l=>l.searched).length, left:v.filter(l=>!l.searched).length}; })(),
    mine: (()=>{ const s=readJSON(path.join(DATA_DIR,'mine-state.json'), {});
      const ps=Object.entries(s).filter(([k])=>k!=='wikidata').map(([,v])=>v);
      return {patterns: ps.length, queued: ps.reduce((n,v)=>n+((v.pending||[]).length),0),
              added: ps.reduce((n,v)=>n+(v.added||0),0), wikidata: s.wikidata||null}; })(),
    activity: readActivity(160),
    perCountry,
    recent
  }, extra||{});

  fs.writeFileSync(STATUS_JSON, JSON.stringify(status, null, 1));
  return status;
}

/* clubs.json — the file the page reads, both on GitHub Pages and locally.
 * Written every tick; publish.js is what pushes it. */
function writeSiteJSON(db){
  const clubs = publishable(db);
  const byCountry = {}, bySport = {Tennis:0, Padel:0, Squash:0};
  for(const c of clubs){
    byCountry[c.country] = (byCountry[c.country]||0)+1;
    for(const s of c.sports) if(s in bySport) bySport[s]++;
  }
  fs.writeFileSync(SITE_JSON, JSON.stringify({
    generated: new Date().toISOString(),
    count: clubs.length,
    byCountry, bySport,
    clubs
  }, null, 1));
  return clubs.length;
}

/* Write a self-contained copy of the database app with the current records
 * baked straight into it. Open data/clubs-database.html by double-clicking
 * and it shows everything collected so far — no server, no import, nothing
 * to click. Rewritten after every tick, so it is never stale by more than
 * one collection run. */
function writeStandalone(db){
  if(!fs.existsSync(APP_FILE)) return 0;
  const clubs = publishable(db);

  let html = fs.readFileSync(APP_FILE, 'utf8');
  // strip any payload from a previous run so they never stack up
  html = html.replace(/<script id="baked-data">[\s\S]*?<\/script>\n?/g, '');

  // escaping < stops a club name containing </script> from breaking out
  const enc = o => JSON.stringify(o).replace(/</g, '\\u003c');
  const payload = '<script id="baked-data">'
    + 'window.__CLUBS__=' + enc(clubs) + ';'
    + 'window.__BAKED__=' + enc(new Date().toISOString()) + ';'
    + '</script>\n';

  html = html.replace('</head>', payload + '</head>');
  fs.writeFileSync(STANDALONE_FILE, html);
  return clubs.length;
}

/* ------------------------------------------------------------------ *
 * One tick
 * ------------------------------------------------------------------ */
let running = false;
let failures = 0;
let failingSince = null;
/* Publishing is damped: the idle rounds between engine cooldowns were
 * committing an unchanged count every twenty seconds — hundreds of
 * "clubs: 6039" commits and a Pages build for each. */
let lastPublishAt = 0, lastPublishCount = -1;
/* Which round this process is on, so the two searching phases can take
 * turns at the engine rather than one of them always going second. */
let roundNo = 0;
async function tick(){
  roundNo++;
  if(running){ log('previous tick still running, skipping this one'); return; }
  running = true;
  const started = Date.now();
  const deadline = started + CFG.budgetMinutes*60*1000;

  try{
    ensureDirs();
    const db = readJSON(DB_FILE, {});
    const queue = syncQueue();

    if(!Object.keys(queue).length){
      log('no seeds yet — add directory URLs to seeds.txt and this will start working');
      running = false; return;
    }

    const roundStarted = new Date().toISOString();
    const busy = phase => writeStatusJSON({running:true, phase, roundStarted});

    // Two lanes, side by side. One reads club sites — the crawl, the LTA
    // register, the placing, the directories, OpenStreetMap — and the other
    // talks to the search engine, which is the one thing in this program
    // with a rate limit and the one thing that reaches a country holding
    // nothing. They used to run in sequence, and the searching lane got
    // what was left of the round after the crawl: two or three minutes out
    // of twenty. Now it gets the round. The engine is paced by design
    // (lib/search.js), so nothing is gained by hurrying it, and everything
    // by letting it run the whole time the other lane is reading.
    const lane = {reading: '', searching: ''};
    const show = () => busy([lane.reading, lane.searching].filter(Boolean).join(' · '));
    const reading   = what => { lane.reading = what; show(); };
    const searching = what => { lane.searching = what; show(); };

    let c = {tried:0, found:0}, lt = {pages:0, added:0, scanned:0}, pl = {tried:0, placed:0};
    let m = {queried:0, vetted:0, added:0}, h = {pages:0, added:0, source:null}, d = {opened:0, found:0};
    let o = {cc:null, added:0};
    let L = {tried:0, found:0, emails:0}, p = {countries:0, added:0};

    const readingLane = async () => {
      // Emails first: it is the point of the whole thing, and the queue of
      // uncrawled sites is what actually converts into records.
      reading('crawling club websites for email addresses');
      c = await phaseCrawl(db, Math.min(deadline, Date.now() + CFG.crawlMinutes*60*1000));
      writeJSON(DB_FILE, db);

      // The LTA register: 994 British venues with the address each one gave
      // its federation. Walked once, then done for good.
      if(Date.now() < deadline){
        reading('reading the LTA venue register');
        lt = await phaseLTA(db, deadline);
        writeJSON(DB_FILE, db);
      }

      // The clubs that have an address but no city yet: the coverage tab
      // counts emails city by city and cannot count these until placed.
      if(Date.now() < deadline){
        reading('reading club sites for the city they are in');
        pl = await phasePlace(db, deadline);
        writeJSON(DB_FILE, db);
      }

      // Domains from the certificate logs and Wikidata, every other round:
      // the certificate words refresh weekly and Wikidata backs off for
      // hours, so most rounds this phase only waits on them.
      if(Date.now() < deadline && roundNo % 2 === 0){
        reading('mining certificate logs for club domains');
        m = await phaseMine(db, deadline);
        writeJSON(DB_FILE, db);
      }

      // Then extend the frontier if there is time left
      if(Date.now() < deadline){
        reading('reading directory pages');
        h = await phaseHarvest(db, queue, deadline);
      }

      // Nothing left to walk means it is time to go and find more to walk,
      // not time to end the round early.
      if(Date.now() < deadline){
        reading('looking for new club directories');
        d = await phaseDiscover(queue, deadline);
      }

      // Save between phases, not only at the end. A round that hangs in a
      // later phase used to throw away everything the earlier ones
      // collected: one round spent half an hour crawling, stalled waiting
      // on Overpass, and was killed with all of it still only in memory.
      writeJSON(DB_FILE, db);
      writeJSON(QUEUE_FILE, queue);

      // Countries from OpenStreetMap, every third round. The countries still
      // unimported are the six biggest, which Overpass answers with 504s
      // most of the day: five minutes of every round bought nothing for a
      // night, while the searches waited.
      if(roundNo % 3 === 0){
        reading('importing countries from OpenStreetMap');
        o = await phaseOSM(db, deadline);
      }
      lane.reading = '';
    };

    const searchingLane = async () => {
      // The two phases that search share one rate-limited engine, and
      // whichever goes first spends the quota, so they take turns: leads
      // convert a name into an address, and prospecting is the only thing
      // that reaches a country holding nothing.
      const leadsFirst = (roundNo % 2) === 1;
      const runLeads = async () => {
        if(Date.now() >= deadline) return;
        searching('searching the web for clubs we only know the name of');
        L = await phaseLeads(db, deadline);
        writeJSON(DB_FILE, db);
      };
      const runProspect = async () => {
        if(Date.now() >= deadline) return;
        searching('searching out clubs, city by city');
        p = await phaseProspect(db, deadline);
        writeJSON(DB_FILE, db);
      };
      if(leadsFirst){ await runLeads(); await runProspect(); }
      else          { await runProspect(); await runLeads(); }
      lane.searching = '';
    };

    await Promise.all([readingLane(), searchingLane()]);

    writeJSON(DB_FILE, db);
    writeJSON(QUEUE_FILE, queue);
    const total = writeExport(db);
    const published = writeSiteJSON(db);
    writeStandalone(db);

    const mins = ((Date.now()-started)/60000).toFixed(1);
    const queued = Object.values(db).filter(r=>!r.email && r.website && (r.attempts||0)<CFG.maxAttempts).length;
    const summary = `crawled ${c.tried} sites, +${c.found} emails` +
        (L.tried ? `; searched ${L.tried} club names, found ${L.found} sites, +${L.emails} emails` : '') +
        (m.vetted || m.added ? `; mined ${m.vetted} domains, +${m.added} clubs` : '') +
        (h.pages ? `; read ${h.pages} pages from ${h.source}, +${h.added} clubs` : '') +
        (lt.pages ? `; lta ${lt.scanned} venues, +${lt.added} clubs` : '') +
        (pl.tried ? `; placed ${pl.placed} of ${pl.tried} clubs in their city` : '') +
        (d.found ? `; found ${d.found} new directories` : '') +
        (p.countries ? `; prospected ${p.countries} empty countries, +${p.added} clubs` : '') +
        (o.cc ? `; osm ${o.countries||0} countries (${o.cc}) +${o.added}` +
                (o.failed ? `, ${o.failed} failed` : '') : '');

    writeStatusJSON({
      running: false,
      phase: 'resting between rounds',
      roundStarted,
      lastRound: {
        at: new Date().toISOString(), minutes: Number(mins), summary,
        crawled: c.tried, emailsFound: c.found,
        pagesRead: h.pages, clubsAdded: h.added,
        osmCountries: o.countries||0, osmAdded: o.added||0, osmFailed: o.failed||0
      }
    });
    // Any change in the count goes out at once; a quiet spell goes out
    // every fifteen minutes, so status.json on the page stays honest
    // without a commit per idle round.
    if(published !== lastPublishCount || Date.now() - lastPublishAt > 15*60*1000){
      publishIfConfigured();
      lastPublishAt = Date.now();
      lastPublishCount = published;
    }

    failures = 0; failingSince = null;
    log(`tick done in ${mins}m — ${summary} | ${total} emails total, ${queued} still queued`);

    // Did this round move anything? The main loop rests longer when not.
    return !!(c.found || p.added || L.found || lt.added || m.added || h.pages || d.found ||
              (o && o.added) || c.tried > 10 || (pl && pl.placed));
  }catch(e){
    /* A round that throws must say so where it can be seen.
     *
     * A missing export made every round fail on its first line for twelve
     * hours — 4,280 of them — while the page went on reporting "resting
     * between rounds", because status.json was only ever written by a round
     * that got far enough to write it. Silence read as calm. */
    failures++;
    log('tick failed: ' + e.message);
    try{
      activity('error', `round failed: ${e.message}`, {ok:false});
      writeStatusJSON({
        running: false,
        phase: `FAILING — ${e.message}`,
        error: e.message,
        failedRounds: failures,
        failingSince: failingSince || (failingSince = new Date().toISOString())
      });
    }catch(_){}

    // Rounds that fail instantly would otherwise spin thousands of times an
    // hour, filling the log and telling nobody.
    await sleep(Math.min(60000, 5000 * failures));
  }finally{
    running = false;
  }
}

/* If publish.js is set up, push the freshly generated page to the static
 * site so the public link stays current. Deliberately swallowed on failure:
 * a git problem must never stop the collecting, which is the actual job. */
function publishIfConfigured(){
  const pub = path.join(ROOT, 'publish.js');
  if(!fs.existsSync(pub) || !fs.existsSync(path.join(ROOT,'publish.json'))) return;
  try{
    const { publish } = require(pub);
    const ok = publish(true);
    log(ok ? 'published to the public link' : 'publish skipped — run `node publish.js` to see why');
  }catch(e){
    log('publish failed (collection unaffected): ' + e.message);
  }
}

/* ------------------------------------------------------------------ *
 * Serve — hosts the database app with live data, so it updates itself
 * ------------------------------------------------------------------ */
function cmdServe(){
  const http = require('http');
  const port = parseInt(process.env.PORT || '8787', 10);
  const APP  = APP_FILE;

  http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];

    if(u === '/status.json'){
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(JSON.stringify(readJSON(STATUS_JSON, {})));
    }

    if(u === '/api/clubs.json' || u === '/clubs.json'){
      const clubs = publishable(readJSON(DB_FILE, {}));
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(JSON.stringify({clubs, count:clubs.length, generated:new Date().toISOString()}));
    }

    if(u === '/' || u === '/index.html'){
      if(fs.existsSync(APP)){
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
        return res.end(fs.readFileSync(APP));
      }
      res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Put racket-club-database.html in this folder, next to daemon.js.');
    }

    res.writeHead(404); res.end('not found');
  }).listen(port, () => {
    log(`serving http://localhost:${port}  — open that and watch it fill up`);
  });
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */
function cmdStatus(){
  const db = readJSON(DB_FILE, {});
  const all = Object.values(db);
  if(!all.length){ console.log('\nNothing collected yet. Add seeds to seeds.txt and start the daemon.\n'); return; }
  const by = {};
  all.forEach(r=>{
    const b = by[r.country] = by[r.country] || {total:0,email:0,queued:0};
    b.total++;
    if(r.email) b.email++;
    else if(r.website && (r.attempts||0) < CFG.maxAttempts) b.queued++;
  });
  console.log('\ncountry                     total   email   queued');
  console.log('-'.repeat(52));
  Object.keys(by).sort((a,b)=>by[b].email-by[a].email).forEach(n=>{
    const b=by[n];
    console.log(n.padEnd(26)+String(b.total).padStart(6)+String(b.email).padStart(8)+String(b.queued).padStart(9));
  });
  const email = all.filter(r=>r.email).length;
  console.log('-'.repeat(52));
  console.log('TOTAL'.padEnd(26)+String(all.length).padStart(6)+String(email).padStart(8));
  console.log(`\n${email} of 10,000 — ${(email/100).toFixed(1)}%`);
  console.log(`CSV ready at ${CSV_FILE}\n`);
}

function cmdSeeds(){
  ensureDirs();
  const q = syncQueue();          // so this works before the first tick
  const list = Object.values(q);
  if(!list.length){ console.log('\nNo seeds. Edit seeds.txt.\n'); return; }
  console.log('\nstatus     pages  country  source');
  console.log('-'.repeat(64));
  list.forEach(s=>{
    console.log((s.done?'exhausted':'working  ').padEnd(11)+String(s.pagesRead).padStart(5)+'  '+s.cc.padEnd(8)+new URL(s.url).hostname);
  });
  console.log('');
}

function cmdInstall(){
  const node = process.execPath;
  const script = path.join(ROOT, 'daemon.js');
  console.log(`
Pick whichever suits the machine. All three run one batch per hour.

── macOS (launchd) ─────────────────────────────────────────────
Save as ~/Library/LaunchAgents/local.racketclubs.plist

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.racketclubs</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string><string>${script}</string><string>once</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${path.join(DATA_DIR,'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(DATA_DIR,'launchd.err.log')}</string>
</dict></plist>

Then:  launchctl load ~/Library/LaunchAgents/local.racketclubs.plist
Stop:  launchctl unload ~/Library/LaunchAgents/local.racketclubs.plist

── Linux / macOS (cron) ────────────────────────────────────────
crontab -e   then add:

0 * * * * cd ${ROOT} && ${node} daemon.js once >> ${path.join(DATA_DIR,'cron.log')} 2>&1

── Linux (systemd) ─────────────────────────────────────────────
~/.config/systemd/user/racketclubs.service
  [Unit]
  Description=Racket club collector
  [Service]
  Type=oneshot
  WorkingDirectory=${ROOT}
  ExecStart=${node} ${script} once

~/.config/systemd/user/racketclubs.timer
  [Unit]
  Description=Hourly racket club collection
  [Timer]
  OnBootSec=5min
  OnUnitActiveSec=1h
  [Install]
  WantedBy=timers.target

  systemctl --user enable --now racketclubs.timer

── Or just leave it running ────────────────────────────────────
  node daemon.js
  nohup node daemon.js > /dev/null 2>&1 &     (survives closing the terminal)
`);
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */
(async function main(){
  const cmd = process.argv[2] || 'run';

  if(cmd === 'status')  return cmdStatus();
  if(cmd === 'seeds')   return cmdSeeds();
  if(cmd === 'install') return cmdInstall();

  // Everything below here collects, and two collectors must never run at
  // once. Taking the lock is the first thing any of them does.
  if(cmd === 'serve' || cmd === 'run' || cmd === 'once'){
    if(!takeLock(cmd)) process.exit(1);
  }

  if(cmd === 'serve'){ ensureDirs(); syncQueue(); cmdServe(); }
  if(cmd === 'once'){ await tick(); return; }

  if(cmd !== 'run' && cmd !== 'serve'){
    console.log(`
Racket club email collector — background daemon

  node daemon.js            run continuously, rounds back to back
  node daemon.js serve      same, plus a live dashboard at http://localhost:8787
  node daemon.js once       single round then exit
  node daemon.js status     what has been collected
  node daemon.js seeds      directory progress

First run creates seeds.txt. Put your directory URLs in there.

Each round crawls the clubs that have a website but no email yet, advances
the seed directories, then imports ${CFG.osmCountries} countries from
OpenStreetMap, and publishes. Then it starts again.

Tuning, all optional:
  BUDGET_MINUTES=20     how long a round may work
  REST_SECONDS=20       gap between rounds
  CONCURRENCY=8         sites crawled at once
  HOST_DELAY_MS=2000    spacing per host
  PAGES_PER_TICK=25     directory pages per round
  OSM_MINUTES=8         slice of the round given to OpenStreetMap
  OSM_COUNTRIES=6       countries per round
  OSM_PARALLEL=4        countries in flight at once. Overpass limits by IP
                        and there are three mirrors; past about six the extra
                        ones only collect refusals. Higher is not faster.
  OSM=off               skip the OpenStreetMap step entirely
  PROSPECT_MINUTES=10   slice for searching out the countries that have none
  PROSPECT=off          skip that step
  DISCOVER_MINUTES=5    slice for walking Curlie for new directories, which
  DISCOVER_PAGES=60     only happens once every seed is exhausted
  DISCOVER=off          skip that step
`);
    return;
  }

  ensureDirs();
  syncQueue();
  log(`daemon started — continuous, ${CFG.budgetMinutes}m per round, ${CFG.restSeconds}s between rounds`);
  log(`crawl concurrency ${CFG.concurrency}, osm ${CFG.osmCountries} countries per round ${CFG.osmParallel} at a time`);
  log(`seeds: ${SEEDS_FILE}`);
  if(!fs.existsSync(APP_FILE)) log(`note: index.html is not in this folder, so no page will be generated`);

  let stopping = false;
  const stop = () => {
    if(stopping) process.exit(0);
    stopping = true;
    log('stopping after the current round — press Ctrl-C again to force');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Rounds back to back, not on a clock. A fixed hourly interval left the
  // machine idle for most of the hour while there were still hundreds of
  // sites queued for an email.
  let round = 0;
  while(!stopping){
    round++;
    const useful = await tick();
    if(stopping) break;
    // A round that moved nothing, against an engine on cooldown, spun
    // every twenty seconds and filled the log. Five minutes is still
    // prompt, and the first round with work to do goes straight back to
    // the short rest.
    await sleep((useful ? CFG.restSeconds : Math.max(CFG.restSeconds, 300)) * 1000);
  }
  log(`stopped after ${round} round${round===1?'':'s'}`);
  process.exit(0);
})();
