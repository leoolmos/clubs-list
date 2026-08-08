#!/usr/bin/env node
/**
 * Directory harvester — the free replacement for Google Places
 * =========================================================================
 * Point it at any page that lists clubs — a federation's affiliated-club
 * directory, a booking platform's club index, a padel portal — and it will
 * walk the pagination, open each club entry, and pull out the name, the
 * club's own website, and the email if the directory publishes one.
 *
 * No API key. No card. No quota. Costs nothing but your bandwidth.
 *
 * Writes to the same data/clubs.json as collect.js, so:
 *   node harvest.js <listing-url> ES     collect entries
 *   node collect.js crawl                fill in any missing emails
 *   node collect.js export               CSV for the database app
 *
 * Node 18+. Zero dependencies.
 * =========================================================================
 */

'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE  = path.join(DATA_DIR, 'clubs.json');
const UA = 'RacketClubResearch/1.0 (+contact: set-your-email-here)';

/* Same country table as collect.js */
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

/* ------------------------------------------------------------------ *
 * Where to point this — free listing sources, in yield order
 * ------------------------------------------------------------------ *
 * Deliberately not hardcoded as URLs, because directory paths change and a
 * stale link wastes a run. Search for these shapes, then pass the listing
 * page you land on as the first argument.
 *
 *  1. Booking platforms. The single richest seam for padel. Platforms that
 *     run court booking for clubs publish a public club index covering
 *     Spain, Portugal, Latin America and the Nordics. Every entry is a real
 *     operating club, and most link out to the club's own site.
 *
 *  2. National federation affiliated-club lists. Tennis, padel and squash
 *     federations each publish one. Usually paginated, often with contact
 *     details already on the page.
 *
 *  3. Regional federation lists. In Spain especially, the seventeen
 *     autonomous-community federations list far more clubs than the
 *     national body does.
 *
 *  4. Padel and tennis portals with club directories.
 *
 *  5. League and competition sites. A league fixture list is a list of
 *     clubs with a secretary's email beside each one.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */
function loadDB(){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
  if(!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch(e){ console.error('Could not read '+DB_FILE+': '+e.message); process.exit(1); }
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,1)); }
function keyFor(rec){
  if(rec.website){
    try { return 'w:'+new URL(rec.website).hostname.replace(/^www\./,'').toLowerCase(); } catch(e){}
  }
  return 'n:'+rec.cc+':'+String(rec.name).toLowerCase().replace(/[^a-z0-9]+/g,'');
}

/* ------------------------------------------------------------------ *
 * Classification (same rules as collect.js)
 * ------------------------------------------------------------------ */
const RE_PADEL  = /p[aá]del/i;
const RE_TENNIS = /\bt[eé]nn?is\b|\btennis\b|\bt[eé]nis\b|lawn tennis/i;
const RE_SQUASH = /\bsquash\b/i;

const RE_PUBLIC = new RegExp([
  'municipal','ayuntamiento','concello','concejo','c[aâ]mara municipal','prefeitura',
  'polideportivo municipal','complejo deportivo municipal','centro deportivo municipal',
  '\\bcouncil\\b','\\bborough\\b','\\bcity of\\b','\\bcounty\\b','parks (and|&) rec',
  'leisure centre','leisure center','community cent','recreation cent','public park',
  'universidad','universidade','university','\\bcollege\\b','\\bschool\\b','colegio','col[eé]gio',
  'instituto','escuela','escola','federaci[oó]n','federa[cç][aã]o','federation','association',
  'ministerio','gobierno','govern','\\bYMCA\\b','\\barmy\\b','\\bnavy\\b','defence','defense'
].join('|'),'i');

const RE_CLUBWORD = /club|clube|tennis|tenis|t[eé]nis|p[aá]del|padel|squash|racquet|racket|lawn/i;

function detectSports(text){
  const s=[];
  if(RE_TENNIS.test(text)) s.push('Tennis');
  if(RE_PADEL.test(text))  s.push('Padel');
  if(RE_SQUASH.test(text)) s.push('Squash');
  return s;
}

/* ------------------------------------------------------------------ *
 * Email extraction (same logic as collect.js — kept local so this file
 * runs standalone)
 * ------------------------------------------------------------------ */
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}/gi;
const JUNK = /(\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$)|(@(2x|3x)\.)|sentry|wixpress|example\.(com|org)|yourdomain|domain\.com|godaddy|squarespace|wordpress\.(com|org)|cloudflare|placeholder|email@|test@|user@/i;
const ROLE_PREFERENCE = ['info','contact','contacto','contato','club','clube','admin','administracion','secretaria','secretariat','reservas','reservations','hello','enquiries','office','mail','general'];

function cfDecode(hex){
  try{
    const key = parseInt(hex.substr(0,2),16);
    let out='';
    for(let i=2;i<hex.length;i+=2) out += String.fromCharCode(parseInt(hex.substr(i,2),16) ^ key);
    return out;
  }catch(e){ return ''; }
}

function extractEmails(html, host){
  const found = new Set();
  (html.match(/data-cfemail="([0-9a-f]+)"/gi)||[]).forEach(m=>{
    const hex = m.match(/"([0-9a-f]+)"/i);
    if(hex){ const d = cfDecode(hex[1]); if(d.includes('@')) found.add(d.toLowerCase()); }
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
    const ar = ROLE_PREFERENCE.indexOf(a.split('@')[0]), br = ROLE_PREFERENCE.indexOf(b.split('@')[0]);
    return (ar<0?99:ar)-(br<0?99:br);
  });
  return clean;
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchText(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), ms||15000);
  try{
    const r = await fetch(url,{ headers:{'User-Agent':UA,'Accept':'text/html,*/*'}, redirect:'follow', signal:ctl.signal });
    if(!r.ok) return null;
    const ct = r.headers.get('content-type')||'';
    if(!/text\/html|application\/xhtml/i.test(ct)) return null;
    return await r.text();
  }catch(e){ return null; }
  finally{ clearTimeout(t); }
}

const robotsCache = new Map();
async function allowed(origin, pathname){
  if(!robotsCache.has(origin)){
    const txt = await fetchText(origin+'/robots.txt', 6000);
    const rules = [];
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

/* ------------------------------------------------------------------ *
 * Page parsing
 * ------------------------------------------------------------------ */
function links(html, base){
  const out=[];
  for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    let href=m[1];
    if(/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let abs; try{ abs=new URL(href, base).toString(); }catch(e){ continue; }
    const text = m[2].replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
    out.push({url:abs, text});
  }
  return out;
}

/* Find the "next page" link, covering the common pagination shapes */
function nextPage(html, base, seen){
  const rel = html.match(/<link[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
  if(rel){ try{ const u=new URL(rel[1],base).toString(); if(!seen.has(u)) return u; }catch(e){} }
  for(const l of links(html, base)){
    if(/^(next|siguiente|próxima|proxima|seguinte|»|>|older)$/i.test(l.text) ||
       /rel=["']next["']/i.test(l.text) ||
       /[?&](page|pagina|p|pg)=\d+|\/page\/\d+/i.test(l.url) && /next|siguiente|próxima|»/i.test(l.text)){
      if(!seen.has(l.url)) return l.url;
    }
  }
  return null;
}

/* Which links on a listing page look like individual clubs? */
function clubCandidates(html, base){
  const all = links(html, base);
  const origin = new URL(base).origin;
  const out = new Map();

  for(const l of all){
    const name = l.text;
    if(!name || name.length < 4 || name.length > 90) continue;
    if(!RE_CLUBWORD.test(name)) continue;
    if(RE_PUBLIC.test(name)) continue;
    if(/^(home|inicio|contacto|contact|about|login|registr|cookie|privac|terms|aviso)/i.test(name)) continue;
    const internal = l.url.startsWith(origin);
    // prefer the first sighting of each name
    if(!out.has(name)) out.set(name, {name, url:l.url, internal});
  }
  return Array.from(out.values());
}

/* Pull the club's own website out of a directory detail page */
function hostOf(u){ try{ return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){ return ''; } }

/* External domains already on the listing page are chrome — sponsors, the
 * designer credit, socials. Never a club website. Without this the first
 * sponsor link becomes every club's "website" and they all collapse into
 * one record, because records are keyed by website host. */
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
  const skip = /facebook|instagram|twitter|x\.com|youtube|linkedin|tiktok|whatsapp|google\.|maps\.|goo\.gl|wa\.me|t\.me|apple\.com|play\.google/i;
  for(const l of links(html, base)){
    if(l.url.startsWith(origin)) continue;
    if(skip.test(l.url)) continue;
    if(chrome && chrome.has(hostOf(l.url))) continue;
    if(/^https?:\/\//i.test(l.url)) return l.url.split('#')[0];
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * The harvest
 * ------------------------------------------------------------------ */
async function harvest(startUrl, cc, maxPages){
  const meta = COUNTRIES[cc];
  if(!meta){ console.error('Unknown country code: '+cc); return; }

  const db = loadDB();
  const seenPages = new Set();
  let pageUrl = startUrl, pages = 0;
  let added=0, merged=0, publicSkipped=0, withEmail=0;

  while(pageUrl && pages < maxPages){
    if(seenPages.has(pageUrl)) break;
    seenPages.add(pageUrl);

    const html = await fetchText(pageUrl);
    if(!html){ console.error('\n  ! could not read '+pageUrl); break; }
    pages++;

    const candidates = clubCandidates(html, pageUrl);

    // Emails sometimes sit right on the listing page. Grab those first —
    // it saves a fetch per club.
    const pageEmails = extractEmails(html, new URL(pageUrl).hostname);
    const chrome = chromeDomains(html, pageUrl);

    for(const c of candidates){
      const sports = detectSports(c.name);
      if(!sports.length) continue;
      if(RE_PUBLIC.test(c.name)){ publicSkipped++; continue; }

      let website = '', email = '';

      if(c.internal){
        // Open the club's page on the directory to find its real site
        let p; try{ p = new URL(c.url).pathname; }catch(e){ continue; }
        const origin = new URL(c.url).origin;
        if(await allowed(origin, p)){
          await sleep(600);
          const detail = await fetchText(c.url);
          if(detail){
            website = outboundSite(detail, c.url, chrome);
            const found = extractEmails(detail, website ? new URL(website).hostname : '');
            if(found.length) email = found[0];
          }
        }
      } else {
        website = c.url;           // directory linked straight to the club
      }

      // Fall back to a listing-page email whose domain matches this club
      if(!email && website && pageEmails.length){
        const host = new URL(website).hostname.replace(/^www\./,'');
        const m = pageEmails.find(e=>e.endsWith('@'+host));
        if(m) email = m;
      }

      const rec = {
        name: c.name, cc, country: meta[0], lang: meta[1], sports,
        website, email, contact:'', src:'harvest',
        srcPage: pageUrl, crawled: !!email
      };
      const k = keyFor(rec);
      if(db[k]){
        if(!db[k].email && rec.email){ db[k].email=rec.email; db[k].crawled=true; withEmail++; }
        if(!db[k].website && rec.website) db[k].website=rec.website;
        db[k].sports = Array.from(new Set(db[k].sports.concat(sports)));
        merged++;
      } else {
        db[k]=rec; added++;
        if(rec.email) withEmail++;
      }
    }

    saveDB(db);
    process.stdout.write(`\r[harvest] page ${pages}  +${added} clubs  ${withEmail} with email already   `);

    pageUrl = nextPage(html, pageUrl, seenPages);
    if(pageUrl) await sleep(900);
  }

  console.log(`\n[harvest] ${pages} page(s) read from ${new URL(startUrl).hostname}`);
  console.log(`[harvest] +${added} new, ${merged} merged, ${publicSkipped} dropped as public/institutional`);
  console.log(`[harvest] ${withEmail} arrived with an email; the rest are queued.`);
  console.log(`[harvest] next:  node collect.js crawl`);
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
(async function main(){
  const args = process.argv.slice(2);
  const url  = args[0];
  const cc   = (args[1]||'').toUpperCase();
  const mp   = parseInt((args.find(a=>a.startsWith('--max-pages='))||'').split('=')[1]||'40',10);

  if(!url || !cc || !/^https?:\/\//i.test(url)){
    console.log(`
Directory harvester — free club discovery, no API key, no card

  node harvest.js <listing-url> <COUNTRY> [--max-pages=40]

Example:
  node harvest.js "https://example-federation.es/clubes" ES
  node collect.js crawl
  node collect.js export

What to point it at, richest first:
  1. Booking platform club indexes   — best coverage for padel
  2. National federation club lists  — tennis, padel and squash each have one
  3. Regional federation lists       — in Spain these hold far more than the national one
  4. Padel and tennis portals with club directories
  5. League sites — a fixture list is a list of clubs with a secretary's email

It walks pagination, opens each club entry, and keeps the name, the club's
own website, and any email the directory already publishes. Anything still
missing an email gets picked up by "node collect.js crawl".

Country codes: ${Object.keys(COUNTRIES).join(' ')}
`);
    return;
  }
  await harvest(url, cc, mp);
})();
