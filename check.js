#!/usr/bin/env node
/**
 * check.js — is this page worth adding to seeds.txt?
 * =========================================================================
 * Fetches a listing page exactly as the daemon would — same character-set
 * handling, same robots.txt rules, same club-name matching — and reports
 * what it would actually get out of it.
 *
 *   node check.js <url> [COUNTRY]
 *   node check.js <url> ES --detail     also open the first club entry
 *
 * The point is to stop guessing. A directory that looks rich in a browser
 * is often useless to a crawler: the list is drawn by JavaScript, or
 * robots.txt disallows it, or the emails are images. Five seconds here
 * saves an hour of a round spent on a page that yields nothing.
 *
 * Every check is appended to data/checked.log, so a page is never
 * investigated twice.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { getPage, links, hostOf, robotsAllow } = require('./lib/http');
const { detectSports, privateClub, extractEmails, extractContactName } = require('./lib/classify');
const { isWanted, nameOf } = require('./lib/countries');

const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'checked.log');
const SEEDS    = path.join(ROOT, 'seeds.txt');

function logCheck(line){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
  fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(0,19)+'  '+line+'\n');
}

function alreadyChecked(url){
  if(!fs.existsSync(LOG_FILE)) return null;
  const want = fs.readFileSync(LOG_FILE,'utf8').split(/\r?\n/).filter(l=>l.includes(url));
  return want.length ? want[want.length-1] : null;
}

function inSeeds(url){
  if(!fs.existsSync(SEEDS)) return false;
  return fs.readFileSync(SEEDS,'utf8').includes(url);
}

async function check(url, cc, wantDetail){
  const prev = alreadyChecked(url);
  if(prev) console.log(`  (checked before: ${prev.slice(21)})`);
  if(inSeeds(url)) console.log(`  (already in seeds.txt)`);

  let u; try{ u = new URL(url); }catch(e){ console.log('  bad URL'); return; }

  const allowed = await robotsAllow(u.origin, u.pathname);
  if(!allowed){
    console.log(`  ROBOTS: disallowed — the daemon will not fetch this, and neither should you.`);
    logCheck(`REJECT robots  ${url}`);
    return;
  }

  const html = await getPage(url);
  if(!html){
    console.log(`  UNREADABLE: no HTML came back (blocked, redirected off-host, or not a page).`);
    logCheck(`REJECT unreadable  ${url}`);
    return;
  }

  const all = links(html, url);
  const emails = extractEmails(html, u.hostname);

  // What clubCandidates would keep
  const clubs = [];
  for(const l of all){
    const n = l.text;
    if(!n || n.length < 4 || n.length > 90) continue;
    if(!detectSports(n).length) continue;
    if(!privateClub({name:n}).ok) continue;
    if(!clubs.some(c=>c.text===n)) clubs.push(l);
  }

  const internal = clubs.filter(c=>c.url.startsWith(u.origin)).length;
  const external = clubs.length - internal;

  console.log(`  ${html.length.toLocaleString()} bytes, ${all.length} links`);
  console.log(`  club-shaped links : ${clubs.length}  (${internal} internal, ${external} straight to club sites)`);
  console.log(`  emails on page    : ${emails.length}${emails.length?'  e.g. '+emails.slice(0,3).join(', '):''}`);

  if(clubs.length){
    console.log(`  sample:`);
    for(const c of clubs.slice(0,6)) console.log(`    - ${c.text}  ->  ${c.url}`);
  }

  // A page with no club links but plenty of markup is usually JavaScript-drawn
  if(!clubs.length){
    const js = /__NEXT_DATA__|window\.__|ng-app|data-react|vue-app|\.json"/.test(html);
    console.log(`  NOTHING FOUND. ${js
      ? 'The page looks JavaScript-drawn — the list is not in the HTML. Open it in the\n' +
        '  browser, watch the network tab, and seed the JSON endpoint it calls instead.'
      : 'No club-shaped links in the HTML at all.'}`);
    logCheck(`REJECT empty${js?'/js':''}  ${url}`);
    return;
  }

  if(wantDetail && clubs.length){
    const first = clubs.find(c=>c.url.startsWith(u.origin)) || clubs[0];
    console.log(`\n  opening one entry: ${first.text}`);
    const d = await getPage(first.url);
    if(!d){ console.log(`    unreadable`); }
    else{
      const de = extractEmails(d, hostOf(first.url));
      const nm = extractContactName(d);
      console.log(`    emails on the club page: ${de.length ? de.slice(0,3).join(', ') : 'none'}`);
      if(nm) console.log(`    contact name: ${nm}`);
    }
  }

  const verdict = (emails.length >= 3 || external >= 3) ? 'GOOD' : 'MAYBE';
  console.log(`\n  ${verdict}: ${clubs.length} clubs visible.` +
              (cc ? `  Add with:  ${cc}  ${url}` : `  (pass a country code to get the seeds.txt line)`));
  logCheck(`${verdict} clubs=${clubs.length} emails=${emails.length} ${cc||'--'}  ${url}`);
}

const args = process.argv.slice(2);
const url  = args[0];
const cc   = (args[1] && !args[1].startsWith('--')) ? args[1].toUpperCase() : '';

if(!url || !/^https?:\/\//i.test(url)){
  console.log(`
Check whether a listing page is worth seeding

  node check.js <url> [COUNTRY] [--detail]

Reports what the daemon would actually extract: whether robots.txt allows
it, how many club-shaped links are in the HTML, and how many emails are
already on the page. Every check is recorded in data/checked.log so the
same page is never investigated twice.
`);
  process.exit(url ? 1 : 0);
}
if(cc && !isWanted(cc)){ console.log(`Unknown country code ${cc}`); process.exit(1); }

console.log(`\n  ${url}${cc?'   ['+cc+' '+nameOf(cc)+']':''}`);
check(url, cc, args.includes('--detail'));
