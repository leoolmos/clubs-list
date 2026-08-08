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
const STANDALONE_FILE = path.join(DATA_DIR, 'clubs-database.html');

const CFG = {
  tickMinutes:   parseInt(process.env.TICK_MINUTES   || '60', 10),  // how often
  budgetMinutes: parseInt(process.env.BUDGET_MINUTES || '20', 10),  // work per tick
  concurrency:   parseInt(process.env.CONCURRENCY    || '8',  10),
  hostDelayMs:   parseInt(process.env.HOST_DELAY_MS  || '2000',10), // per host
  pagesPerTick:  parseInt(process.env.PAGES_PER_TICK || '25', 10),
  maxAttempts:   3
};

const { COUNTRIES, ccFromHost, isWanted } = require('./lib/countries');
const { detectSports, privateClub, extractEmails, extractContactName,
        plausibleSite, siteFromEmail, RE_PUBLIC, RE_CLUBWORD } = require('./lib/classify');
const osm = require('./lib/osm');


const UA = 'RacketClubResearch/1.0 (club directory research; contact: set-your-email@example.com)';

/* ------------------------------------------------------------------ *
 * Polite fetching — per-host spacing, robots.txt, character sets      *
 * ------------------------------------------------------------------ */
const { sleep, links, hostOf, robotsAllow } = require('./lib/http');
const getPage = url => require('./lib/http').getPage(url, CFG.hostDelayMs);


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

const CONTACT_PATHS = ['/contact','/contact-us','/contacto','/contactos','/contacta','/contato','/kontakt','/about','/quienes-somos','/sobre-nos','/socios','/membership','/reservas','/impressum'];
const RE_CONTACT_LINK = /contact|contacto|contacta|contato|kontakt|about|quienes|sobre|nosotros|socios|membership|impressum|reservas/i;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
function ensureDirs(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
function readJSON(f, fallback){
  if(!fs.existsSync(f)) return fallback;
  try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return fallback; }
}
function writeJSON(f, o){ fs.writeFileSync(f, JSON.stringify(o,null,1)); }

function log(msg){
  ensureDirs();
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try{ fs.appendFileSync(LOG_FILE, line+'\n'); }catch(e){}
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
  for(const s of loadSeeds()){
    if(!q[s.url]){
      q[s.url] = {cc:s.cc, url:s.url, nextPage:s.url, seenPages:[], pagesRead:0, done:false, added:new Date().toISOString().slice(0,10)};
    }
  }
  writeJSON(QUEUE_FILE, q);
  return q;
}

/* ------------------------------------------------------------------ *
 * Work: crawl club sites that still lack an email
 * ------------------------------------------------------------------ */
async function harvestSite(website){
  let origin, host;
  try{ const u=new URL(website); origin=u.origin; host=u.hostname; }
  catch(e){ return {emails:[], note:'bad url'}; }

  const home = await getPage(origin);
  if(!home) return {emails:[], contact:'', note:'unreachable'};

  let emails = extractEmails(home, host);
  if(emails.length) return {emails, contact:extractContactName(home), note:'homepage'};

  const found = links(home, origin)
    .filter(l=>RE_CONTACT_LINK.test(l.url) || RE_CONTACT_LINK.test(l.text))
    .map(l=>l.url).filter(u=>u.startsWith(origin));

  const queue = Array.from(new Set(found.concat(CONTACT_PATHS.map(p=>origin+p)))).slice(0,6);
  for(const url of queue){
    const html = await getPage(url);
    if(!html) continue;
    emails = extractEmails(html, host);
    if(emails.length){
      const contact = extractContactName(html);
      try{ return {emails, contact, note:new URL(url).pathname}; }
      catch(e){ return {emails, contact, note:'contact page'}; }
    }
  }
  return {emails:[], contact:'', note:'no email published'};
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

async function phaseCrawl(db, deadline){
  const today = Date.now();
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
    const {emails, contact, note} = await harvestSite(rec.website);
    tried++;
    rec.attempts = (rec.attempts||0)+1;
    rec.crawlNote = note;
    rec.lastTried = new Date().toISOString().slice(0,10);
    if(emails.length){
      rec.email = emails[0];
      rec.alt = emails.slice(1,4);
      if(contact && !rec.contact) rec.contact = contact;
      rec.crawled = true;
      found++;
    } else if(note === 'no email published'){
      rec.attempts = CFG.maxAttempts;         // settled, do not retry
      rec.crawled = true;
    } else {
      rec.retryAfter = today + rec.attempts * 24*60*60*1000;   // 1d, 2d, 3d
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

  const cc = osm.nextCountry();
  if(!cc) return {cc:null, added:0};

  try{
    const s = await osm.importCountry(cc, db, m=>log(m), deadline);
    if(s.error){
      log(`osm ${cc} failed: ${s.error}`);
      osm.markDone(cc, {error:s.error});
      return {cc, added:0, error:s.error};
    }
    osm.markDone(cc, {seen:s.seen, added:s.added, merged:s.merged, rejected:s.rejected,
                      leads:s.leads, partial:s.partial||null,
                      via:(s.endpoint||'').replace(/^https?:\/\//,'').split('/')[0]});
    return {cc, added:s.added};
  }catch(e){
    log(`osm ${cc} threw: ${e.message}`);
    return {cc, added:0, error:e.message};
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
async function tick(){
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

    // Emails first: it is the point of the whole thing, and the queue of
    // uncrawled sites is what actually converts into records.
    const c = await phaseCrawl(db, deadline);
    writeJSON(DB_FILE, db);

    // Then extend the frontier if there is time left
    let h = {pages:0, added:0, source:null};
    if(Date.now() < deadline) h = await phaseHarvest(db, queue, deadline);

    // Save between phases, not only at the end. A round that hangs in a
    // later phase used to throw away everything the earlier ones collected:
    // one round spent half an hour crawling, stalled waiting on Overpass,
    // and was killed with all of it still only in memory.
    writeJSON(DB_FILE, db);
    writeJSON(QUEUE_FILE, queue);

    // One country from OpenStreetMap per tick. Slow on purpose — it is a free
    // shared service — but it is what reaches the countries with no federation
    // directory to walk, and over a day it works through the whole list.
    const o = await phaseOSM(db, deadline);

    writeJSON(DB_FILE, db);
    writeJSON(QUEUE_FILE, queue);
    const total = writeExport(db);
    writeSiteJSON(db);
    writeStandalone(db);
    publishIfConfigured();

    const mins = ((Date.now()-started)/60000).toFixed(1);
    const queued = Object.values(db).filter(r=>!r.email && r.website && (r.attempts||0)<CFG.maxAttempts).length;
    log(`tick done in ${mins}m — crawled ${c.tried} sites, +${c.found} emails` +
        (h.pages ? `; read ${h.pages} pages from ${h.source}, +${h.added} clubs` : '') +
        (o.cc ? `; osm ${o.cc} +${o.added}` : '') +
        ` | ${total} emails total, ${queued} still queued`);
  }catch(e){
    log('tick failed: '+e.message);
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
  if(cmd === 'serve'){ ensureDirs(); syncQueue(); cmdServe(); }
  if(cmd === 'seeds')   return cmdSeeds();
  if(cmd === 'install') return cmdInstall();
  if(cmd === 'once'){ await tick(); return; }

  if(cmd !== 'run' && cmd !== 'serve'){
    console.log(`
Racket club email collector — background daemon

  node daemon.js            run continuously, one batch every ${CFG.tickMinutes} minutes
  node daemon.js serve      same, plus a live dashboard at http://localhost:8787
  node daemon.js once       single batch then exit (use with cron or launchd)
  node daemon.js status     what has been collected
  node daemon.js seeds      directory progress
  node daemon.js install    scheduler config for this machine

First run creates seeds.txt. Put your directory URLs in there.

Keep racket-club-database.html in this folder and every run rewrites
data/clubs-database.html with the latest records baked in. Open that file
whenever you like — it always shows the full current list, offline.

Tuning, all optional:
  TICK_MINUTES=60  BUDGET_MINUTES=20  CONCURRENCY=8  HOST_DELAY_MS=2000
`);
    return;
  }

  ensureDirs();
  syncQueue();
  log(`daemon started — batch every ${CFG.tickMinutes}m, up to ${CFG.budgetMinutes}m of work each, concurrency ${CFG.concurrency}`);
  log(`seeds: ${SEEDS_FILE}`);
  log(`open this any time: ${STANDALONE_FILE}`);
  if(!fs.existsSync(APP_FILE)) log(`note: racket-club-database.html is not in this folder, so no page will be generated`);

  let stopping = false;
  const stop = () => {
    if(stopping) process.exit(0);
    stopping = true;
    log('stopping after the current batch — press Ctrl-C again to force');
    setTimeout(()=>process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await tick();
  setInterval(tick, CFG.tickMinutes*60*1000);
})();
