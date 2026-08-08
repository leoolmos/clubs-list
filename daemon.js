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

const ROOT      = process.cwd();
const DATA_DIR  = path.join(ROOT, 'data');
const DB_FILE   = path.join(DATA_DIR, 'clubs.json');
const QUEUE_FILE= path.join(DATA_DIR, 'queue.json');
const LOG_FILE  = path.join(DATA_DIR, 'daemon.log');
const CSV_FILE  = path.join(DATA_DIR, 'clubs-export.csv');
const SEEDS_FILE= path.join(ROOT, 'seeds.txt');
const APP_FILE  = path.join(ROOT, 'racket-club-database.html');
const STANDALONE_FILE = path.join(DATA_DIR, 'clubs-database.html');

const CFG = {
  tickMinutes:   parseInt(process.env.TICK_MINUTES   || '60', 10),  // how often
  budgetMinutes: parseInt(process.env.BUDGET_MINUTES || '20', 10),  // work per tick
  concurrency:   parseInt(process.env.CONCURRENCY    || '8',  10),
  hostDelayMs:   parseInt(process.env.HOST_DELAY_MS  || '2000',10), // per host
  pagesPerTick:  parseInt(process.env.PAGES_PER_TICK || '25', 10),
  maxAttempts:   3
};

/* ------------------------------------------------------------------ *
 * Countries
 * ------------------------------------------------------------------ */
const COUNTRIES = {
  AR:['Argentina','Spanish'], BO:['Bolivia','Spanish'], CL:['Chile','Spanish'],
  CO:['Colombia','Spanish'], CR:['Costa Rica','Spanish'], CU:['Cuba','Spanish'],
  DO:['Dominican Republic','Spanish'], EC:['Ecuador','Spanish'], SV:['El Salvador','Spanish'],
  GQ:['Equatorial Guinea','Spanish'], GT:['Guatemala','Spanish'], HN:['Honduras','Spanish'],
  MX:['Mexico','Spanish'], NI:['Nicaragua','Spanish'], PA:['Panama','Spanish'],
  PY:['Paraguay','Spanish'], PE:['Peru','Spanish'], ES:['Spain','Spanish'],
  UY:['Uruguay','Spanish'], VE:['Venezuela','Spanish'],
  AO:['Angola','Portuguese'], BR:['Brazil','Portuguese'], CV:['Cape Verde','Portuguese'],
  TL:['East Timor','Portuguese'], GW:['Guinea-Bissau','Portuguese'], MZ:['Mozambique','Portuguese'],
  PT:['Portugal','Portuguese'], ST:['São Tomé and Príncipe','Portuguese'],
  AG:['Antigua and Barbuda','English'], AU:['Australia','English'], BS:['Bahamas','English'],
  BB:['Barbados','English'], BZ:['Belize','English'], BW:['Botswana','English'],
  CA:['Canada','English'], DM:['Dominica','English'], FJ:['Fiji','English'],
  GM:['Gambia','English'], GH:['Ghana','English'], GD:['Grenada','English'],
  GY:['Guyana','English'], IN:['India','English'], IE:['Ireland','English'],
  JM:['Jamaica','English'], KE:['Kenya','English'], KI:['Kiribati','English'],
  LS:['Lesotho','English'], LR:['Liberia','English'], MW:['Malawi','English'],
  MT:['Malta','English'], MH:['Marshall Islands','English'], MU:['Mauritius','English'],
  FM:['Micronesia','English'], NA:['Namibia','English'], NR:['Nauru','English'],
  NZ:['New Zealand','English'], NG:['Nigeria','English'], PK:['Pakistan','English'],
  PW:['Palau','English'], PG:['Papua New Guinea','English'], PH:['Philippines','English'],
  RW:['Rwanda','English'], KN:['Saint Kitts and Nevis','English'], LC:['Saint Lucia','English'],
  VC:['Saint Vincent and the Grenadines','English'], WS:['Samoa','English'],
  SC:['Seychelles','English'], SL:['Sierra Leone','English'], SG:['Singapore','English'],
  SB:['Solomon Islands','English'], ZA:['South Africa','English'], SS:['South Sudan','English'],
  SD:['Sudan','English'], TZ:['Tanzania','English'], TO:['Tonga','English'],
  TT:['Trinidad and Tobago','English'], TV:['Tuvalu','English'], UG:['Uganda','English'],
  GB:['United Kingdom','English'], US:['United States','English'], VU:['Vanuatu','English'],
  ZM:['Zambia','English'], ZW:['Zimbabwe','English']
};

const UA = 'RacketClubResearch/1.0 (club directory research; contact: set-your-email@example.com)';

/* ------------------------------------------------------------------ *
 * Matching rules
 * ------------------------------------------------------------------ */
const RE_TENNIS = /\bt[eé]nn?is\b|\btennis\b|\bt[eé]nis\b|lawn tennis/i;
const RE_PADEL  = /p[aá]del/i;
const RE_SQUASH = /\bsquash\b/i;
const RE_CLUBWORD = /club|clube|tennis|tenis|t[eé]nis|p[aá]del|padel|squash|racquet|racket|lawn/i;

const RE_PUBLIC = new RegExp([
  'municipal','ayuntamiento','concello','concejo','c[aâ]mara municipal','prefeitura',
  'polideportivo municipal','complejo deportivo municipal','centro deportivo municipal',
  '\\bcouncil\\b','\\bborough\\b','\\bcity of\\b','\\bcounty\\b','parks (and|&) rec',
  'leisure centre','leisure center','community cent','recreation cent','public park',
  'universidad','universidade','university','\\bcollege\\b','\\bschool\\b','colegio','col[eé]gio',
  'instituto','escuela','escola','federaci[oó]n','federa[cç][aã]o','federation','association',
  'ministerio','gobierno','govern','\\bYMCA\\b','\\barmy\\b','\\bnavy\\b','defence','defense'
].join('|'),'i');

function detectSports(t){
  const s=[];
  if(RE_TENNIS.test(t)) s.push('Tennis');
  if(RE_PADEL.test(t))  s.push('Padel');
  if(RE_SQUASH.test(t)) s.push('Squash');
  return s;
}

/* ------------------------------------------------------------------ *
 * Email extraction
 * ------------------------------------------------------------------ */
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}/gi;
const JUNK = /(\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$)|(@(2x|3x)\.)|sentry|wixpress|example\.(com|org)|yourdomain|domain\.com|godaddy|squarespace|wordpress\.(com|org)|cloudflare|placeholder|email@|test@|user@/i;
const ROLE_PREFERENCE = ['info','contact','contacto','contato','club','clube','admin','administracion','secretaria','secretariat','reservas','reservations','hello','enquiries','office','mail','general'];

function cfDecode(hex){
  try{
    const key = parseInt(hex.substr(0,2),16);
    let out='';
    for(let i=2;i<hex.length;i+=2) out += String.fromCharCode(parseInt(hex.substr(i,2),16)^key);
    return out;
  }catch(e){ return ''; }
}

function extractEmails(html, host){
  const found = new Set();
  (html.match(/data-cfemail="([0-9a-f]+)"/gi)||[]).forEach(m=>{
    const h=m.match(/"([0-9a-f]+)"/i);
    if(h){ const d=cfDecode(h[1]); if(d.includes('@')) found.add(d.toLowerCase()); }
  });
  (html.match(/mailto:([^"'?\s>]+)/gi)||[]).forEach(m=>found.add(m.replace(/mailto:/i,'').toLowerCase()));
  const deob = html
    .replace(/\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*|\s+at\s+/gi,'@')
    .replace(/\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*|\s+dot\s+/gi,'.');
  (html.match(EMAIL_RE)||[]).forEach(e=>found.add(e.toLowerCase()));
  (deob.match(EMAIL_RE)||[]).forEach(e=>found.add(e.toLowerCase()));

  const clean = Array.from(found)
    .map(e=>e.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi,''))
    .filter(e=>/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}$/i.test(e))
    .filter(e=>!JUNK.test(e))
    .filter(e=>!/^(no-?reply|donotreply|postmaster|hostmaster|abuse|privacy|dmarc|webmaster)@/i.test(e));

  const bare = host ? host.replace(/^www\./,'') : '';
  clean.sort((a,b)=>{
    const ad = bare && a.endsWith('@'+bare)?0:1, bd = bare && b.endsWith('@'+bare)?0:1;
    if(ad!==bd) return ad-bd;
    const ar=ROLE_PREFERENCE.indexOf(a.split('@')[0]), br=ROLE_PREFERENCE.indexOf(b.split('@')[0]);
    return (ar<0?99:ar)-(br<0?99:br);
  });
  return clean;
}

/* ------------------------------------------------------------------ *
 * Polite fetching — per-host spacing, robots.txt, hard timeouts
 * ------------------------------------------------------------------ */
const lastHit = new Map();
const robotsCache = new Map();
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function politeWait(host){
  const now = Date.now();
  const prev = lastHit.get(host) || 0;
  const wait = CFG.hostDelayMs - (now - prev);
  if(wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function rawFetch(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), ms||15000);
  try{
    const r = await fetch(url,{ headers:{'User-Agent':UA,'Accept':'text/html,*/*'}, redirect:'follow', signal:ctl.signal });
    if(!r.ok) return null;
    const ct = r.headers.get('content-type')||'';
    if(!/text\/html|application\/xhtml/i.test(ct)) return null;
    const buf = await r.arrayBuffer();
    if(buf.byteLength > 4_000_000) return null;         // skip absurd pages
    return Buffer.from(buf).toString('utf8');
  }catch(e){ return null; }
  finally{ clearTimeout(t); }
}

async function robotsAllow(origin, pathname){
  if(!robotsCache.has(origin)){
    const txt = await rawFetch(origin+'/robots.txt', 6000);
    const rules=[];
    if(txt){
      let applies=false;
      for(const line of txt.split(/\r?\n/)){
        const l=line.trim();
        if(/^user-agent:/i.test(l)) applies=/\*\s*$/.test(l);
        else if(applies && /^disallow:/i.test(l)){
          const p=l.split(':')[1].trim();
          if(p) rules.push(p);
        }
      }
    }
    robotsCache.set(origin, rules);
  }
  return !robotsCache.get(origin).some(r=>pathname.startsWith(r));
}

async function getPage(url){
  let u; try{ u=new URL(url); }catch(e){ return null; }
  if(!/^https?:$/.test(u.protocol)) return null;
  if(!(await robotsAllow(u.origin, u.pathname))) return null;
  await politeWait(u.hostname);
  return rawFetch(url);
}

/* ------------------------------------------------------------------ *
 * Link parsing
 * ------------------------------------------------------------------ */
function links(html, base){
  const out=[];
  for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    if(/^(#|javascript:|mailto:|tel:)/i.test(m[1])) continue;
    let abs; try{ abs=new URL(m[1], base).toString(); }catch(e){ continue; }
    const text = m[2].replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
    out.push({url:abs, text});
  }
  return out;
}

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

function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){ return ''; } }

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

function outboundSite(html, base, chrome){
  const origin = new URL(base).origin;
  const skip = /facebook|instagram|twitter|x\.com|youtube|linkedin|tiktok|whatsapp|google\.|maps\.|goo\.gl|wa\.me|t\.me|apple\.com|play\.google|wikipedia/i;
  for(const l of links(html, base)){
    if(l.url.startsWith(origin)) continue;
    if(skip.test(l.url)) continue;
    if(chrome && chrome.has(hostOf(l.url))) continue;
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
      const m = l.match(/^([A-Za-z]{2})\s+(https?:\/\/\S+)$/);
      return m ? {cc:m[1].toUpperCase(), url:m[2]} : null;
    })
    .filter(s=>s && COUNTRIES[s.cc]);
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
  if(!home) return {emails:[], note:'unreachable'};

  let emails = extractEmails(home, host);
  if(emails.length) return {emails, note:'homepage'};

  const found = links(home, origin)
    .filter(l=>RE_CONTACT_LINK.test(l.url) || RE_CONTACT_LINK.test(l.text))
    .map(l=>l.url).filter(u=>u.startsWith(origin));

  const queue = Array.from(new Set(found.concat(CONTACT_PATHS.map(p=>origin+p)))).slice(0,6);
  for(const url of queue){
    const html = await getPage(url);
    if(!html) continue;
    emails = extractEmails(html, host);
    if(emails.length){ try{ return {emails, note:new URL(url).pathname}; }catch(e){ return {emails, note:'contact page'}; } }
  }
  return {emails:[], note:'no email published'};
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
    const {emails, note} = await harvestSite(rec.website);
    tried++;
    rec.attempts = (rec.attempts||0)+1;
    rec.crawlNote = note;
    rec.lastTried = new Date().toISOString().slice(0,10);
    if(emails.length){
      rec.email = emails[0];
      rec.alt = emails.slice(1,4);
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
  const seed = pending[0];
  const meta = COUNTRIES[seed.cc];
  let pages=0, added=0;

  while(seed.nextPage && pages < CFG.pagesPerTick && Date.now() < deadline){
    const url = seed.nextPage;
    if(seed.seenPages.includes(url)){ seed.done = true; break; }

    const html = await getPage(url);
    if(!html){ seed.done = true; seed.note='page unreadable: '+url; break; }

    seed.seenPages.push(url);
    seed.pagesRead++;
    pages++;

    const pageEmails = extractEmails(html, new URL(url).hostname);
    const chrome = chromeDomains(html, url);

    for(const c of clubCandidates(html, url)){
      if(Date.now() > deadline) break;
      const sports = detectSports(c.name);
      if(!sports.length) continue;

      let website='', email='';
      if(c.internal){
        const detail = await getPage(c.url);
        if(detail){
          website = outboundSite(detail, c.url, chrome);
          const f = extractEmails(detail, website ? new URL(website).hostname : '');
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

      const rec = {name:c.name, cc:seed.cc, country:meta[0], lang:meta[1], sports,
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
  return {pages, added, source:new URL(seed.url).hostname};
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */
function csvCell(v){ const s=String(v==null?'':v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function writeExport(db){
  const rows = Object.values(db).filter(r=>r.email && r.sports && r.sports.length);
  const lines = rows.map(r=>[r.name, r.sports.join('+'), r.contact||'', r.email, r.country].map(csvCell).join(','));
  fs.writeFileSync(CSV_FILE, lines.join('\n'));
  return rows.length;
}

/* Write a self-contained copy of the database app with the current records
 * baked straight into it. Open data/clubs-database.html by double-clicking
 * and it shows everything collected so far — no server, no import, nothing
 * to click. Rewritten after every tick, so it is never stale by more than
 * one collection run. */
function writeStandalone(db){
  if(!fs.existsSync(APP_FILE)) return 0;
  const clubs = Object.values(db)
    .filter(r => r.email && r.sports && r.sports.length)
    .map(r => ({name:r.name, sports:r.sports, contact:r.contact||'', email:r.email,
                lang:r.lang, country:r.country, src:r.src, stale:false}));

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

    // Then extend the frontier if there is time left
    let h = {pages:0, added:0, source:null};
    if(Date.now() < deadline) h = await phaseHarvest(db, queue, deadline);

    writeJSON(DB_FILE, db);
    writeJSON(QUEUE_FILE, queue);
    const total = writeExport(db);
    writeStandalone(db);
    publishIfConfigured();

    const mins = ((Date.now()-started)/60000).toFixed(1);
    const queued = Object.values(db).filter(r=>!r.email && r.website && (r.attempts||0)<CFG.maxAttempts).length;
    log(`tick done in ${mins}m — crawled ${c.tried} sites, +${c.found} emails` +
        (h.pages ? `; read ${h.pages} pages from ${h.source}, +${h.added} clubs` : '') +
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

    if(u === '/api/clubs.json'){
      const db = readJSON(DB_FILE, {});
      const clubs = Object.values(db)
        .filter(r => r.email && r.sports && r.sports.length)
        .map(r => ({name:r.name, sports:r.sports, contact:r.contact||'', email:r.email,
                    lang:r.lang, country:r.country, src:r.src, stale:false}));
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(JSON.stringify({clubs, generated:new Date().toISOString()}));
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
