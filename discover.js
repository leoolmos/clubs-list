#!/usr/bin/env node
/**
 * discover.js — find new club directories automatically
 * =========================================================================
 * Seeds are the bottleneck. Every directory has to be found, opened and
 * judged, and doing that by hand is what makes a list like this take weeks.
 *
 * This walks the open-directory tree at Curlie, which has a maintained
 * regional index of tennis, squash and racquet club listings country by
 * country, and turns the useful ones into seed lines.
 *
 * Curlie is a curated human-edited directory, so a category page holds
 * links to the clubs' own websites — exactly the shape the crawler wants.
 * The links are old in places, but a club that has moved usually still
 * answers on the same domain.
 *
 *   node discover.js              walk the tree, add what is good
 *   node discover.js --dry        show what it would add, change nothing
 *   node discover.js --max=200    how many category pages to open
 *
 * Everything opened is recorded in data/discovered.log, and the walk skips
 * anything already logged — so running it again picks up where it stopped
 * instead of re-reading the same six hundred pages.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { getPage, links, sleep } = require('./lib/http');
const { detectSports, privateClub, extractEmails } = require('./lib/classify');
const { COUNTRIES, isWanted } = require('./lib/countries');

/* 1.2s of spacing got better than half the pages refused. Curlie is run by
 * volunteers on donated hosting; 3s is the polite rate that actually works. */
const HOST_DELAY = parseInt(process.env.HOST_DELAY_MS || '3000', 10);

const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SEEN_LOG = path.join(DATA_DIR, 'discovered.log');
const SEEDS    = path.join(ROOT, 'seeds.txt');

/* Where to start. Both the sport-first tree and the region-first tree: they
 * cross-link, but each holds categories the other does not. */
const ROOTS = [
  'https://curlie.org/en/Sports/Tennis/By_Region',
  'https://curlie.org/en/Sports/Squash/Clubs',
  'https://curlie.org/en/Sports/Squash/Directories',
  'https://curlie.org/en/Sports/Tennis/Directories',
  'https://curlie.org/en/Sports/Paddleball',
  'https://curlie.org/en/Sports/Racquetball/Clubs'
];

/* Curlie writes country names into the path: .../Regional/Europe/Spain/...
 * Map those back to the country codes we care about. */
const NAME_TO_CC = {};
for(const [cc, [name]] of Object.entries(COUNTRIES)){
  NAME_TO_CC[name.replace(/\s+/g,'_')] = cc;
}
// spellings Curlie uses that differ from the country table
Object.assign(NAME_TO_CC, {
  United_States: 'US', United_Kingdom: 'GB', New_Zealand: 'NZ',
  South_Africa: 'ZA', Trinidad_and_Tobago: 'TT', Papua_New_Guinea: 'PG',
  Cape_Verde: 'CV', East_Timor: 'TL', Timor_Leste: 'TL',
  Antigua_and_Barbuda: 'AG', 'Saint_Lucia': 'LC', Costa_Rica: 'CR',
  Dominican_Republic: 'DO', El_Salvador: 'SV', Puerto_Rico: null   // not in the brief
});

function ccFromPath(url){
  for(const part of url.split('/')){
    const hit = NAME_TO_CC[part];
    if(hit && isWanted(hit)) return hit;
  }
  return '';
}

/* ------------------------------------------------------------------ */
function readSeen(){
  if(!fs.existsSync(SEEN_LOG)) return new Map();
  const m = new Map();
  for(const line of fs.readFileSync(SEEN_LOG,'utf8').split(/\r?\n/)){
    const sp = line.indexOf(' ');
    if(sp > 0) m.set(line.slice(sp+1).trim(), line.slice(0,sp));
  }
  return m;
}
let DRY = false;
function note(verdict, url){
  if(DRY) return;                       // --dry promises to change nothing
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.appendFileSync(SEEN_LOG, `${verdict} ${url}\n`);
}

function seedsText(){ return fs.existsSync(SEEDS) ? fs.readFileSync(SEEDS,'utf8') : ''; }

function addSeeds(entries){
  if(!entries.length) return;
  let txt = seedsText();
  if(txt && !txt.endsWith('\n')) txt += '\n';
  txt += `\n# ---------------------------------------------------------------------\n`;
  txt += `# Found by discover.js on ${new Date().toISOString().slice(0,10)}\n`;
  txt += `# Curlie category pages that link straight out to club websites.\n`;
  txt += `# ---------------------------------------------------------------------\n`;
  for(const e of entries) txt += `${e.cc}  ${e.url}\n`;
  fs.writeFileSync(SEEDS, txt);
}

/* ------------------------------------------------------------------ *
 * Judge a category page
 * ------------------------------------------------------------------ */
function judge(html, url){
  const origin = new URL(url).origin;
  const all = links(html, url);

  let clubs = 0;
  for(const l of all){
    if(l.url.startsWith(origin)) continue;              // still inside Curlie
    const n = l.text;
    if(!n || n.length < 4 || n.length > 90) continue;
    if(!detectSports(n).length) continue;
    if(!privateClub({name:n, website:l.url}).ok) continue;
    clubs++;
  }

  // Follow only branches that are still about racket sports. Without this the
  // walk leaves the tennis tree at the first regional hub and starts working
  // through the whole of Curlie — 25 pages in, the queue held 271 pages and
  // not one of them was a club list.
  const RELEVANT = /(Tennis|Squash|Racquet|Racket|Padel|Paddle)/i;
  const subcats = Array.from(new Set(
    all.filter(l => l.url.startsWith(origin))
       .filter(l => /\/en\/(Sports|Regional)\//.test(l.url))
       .filter(l => RELEVANT.test(l.url))
       .map(l => l.url.split('#')[0].replace(/\/$/,''))
  ));

  return {clubs, subcats, emails: extractEmails(html, new URL(url).hostname).length};
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */
async function main(){
  const args = process.argv.slice(2);
  const dry  = args.includes('--dry');
  DRY = dry;
  const max  = parseInt((args.find(a=>a.startsWith('--max='))||'').split('=')[1] || '150', 10);

  const seen = readSeen();
  const queue = ROOTS.slice();
  const found = [];
  const already = seedsText();
  let opened = 0, skipped = 0, misses = 0;

  console.log(`\n  walking Curlie for club directories (up to ${max} pages)\n`);

  while(queue.length && opened < max){
    const url = queue.shift().replace(/\/$/,'');
    if(seen.has(url)){ skipped++; continue; }

    const html = await getPage(url, HOST_DELAY);
    opened++;
    if(!html){
      // Almost always throttling rather than a dead page: a burst of these
      // appeared exactly when the walk sped up. Recorded as RETRY, and a
      // later run tries it again — logging DEAD wrote off 122 pages, more
      // than half the walk, and none of them would ever be looked at again.
      note('RETRY', url);
      misses++;
      if(misses >= 5){
        console.log(`  (being throttled - backing off for a minute)`);
        await sleep(60000);
        misses = 0;
      }
      continue;
    }
    misses = 0;

    const {clubs, subcats} = judge(html, url);
    const cc = ccFromPath(url) || 'AUTO';

    // A country in the path is better, but its absence is not a reason to
    // throw the page away: an international index is exactly what AUTO is
    // for, and each club's country then comes from its own domain. Judging
    // these as unusable discarded the richest page in the whole walk, the
    // 78-club squash index.
    if(clubs >= 5){
      note('SEED', url);
      seen.set(url,'SEED');
      if(!already.includes(url)){
        found.push({cc, url, clubs});
        console.log(`  + ${String(clubs).padStart(3)} clubs  ${cc.padEnd(4)}  ${url}`);
      }
    } else {
      note('THIN', url);
      seen.set(url, 'THIN');
    }

    // Keep walking down the tree regardless: a hub page has no club links of
    // its own but its children are the actual lists.
    for(const s of subcats){
      if(!seen.has(s) && !queue.includes(s)) queue.push(s);
    }

    if(opened % 20 === 0) process.stdout.write(`  ...${opened} pages opened, ${found.length} seeds found\n`);
    await sleep(HOST_DELAY);     // Curlie is a volunteer-run service
  }

  console.log(`\n  opened ${opened} pages, skipped ${skipped} already known`);
  console.log(`  ${found.length} new seed${found.length===1?'':'s'}` +
              (queue.length ? `, ${queue.length} pages still in the queue for next time` : ', tree exhausted'));

  if(!found.length) return;

  if(dry){
    console.log(`\n  --dry, so seeds.txt was not touched. Lines that would be added:\n`);
    for(const f of found) console.log(`${f.cc}  ${f.url}`);
    return;
  }

  addSeeds(found);
  const byCc = {};
  for(const f of found) byCc[f.cc] = (byCc[f.cc]||0) + 1;
  console.log(`\n  added to seeds.txt: ` +
              Object.entries(byCc).sort((a,b)=>b[1]-a[1]).map(([c,n])=>`${c}×${n}`).join(' '));
  console.log(`  the daemon picks them up on its next round.\n`);
}

main();
