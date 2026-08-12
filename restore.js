#!/usr/bin/env node
/**
 * restore.js — rebuild the working store from the published list
 * =========================================================================
 * `data/` is deliberately not in git: it is large, rewritten every round,
 * and of no use to the page. The cost of that is a machine with a fresh
 * clone has the 1,041 published clubs in clubs.json and no database behind
 * them — and the first round it runs would export an almost empty file over
 * the top of the real one, because the export is written from the store and
 * the store is what is missing.
 *
 * This puts the published rows back into the store first. They arrive
 * settled: each already carries the email that is the point of the whole
 * exercise, so nothing re-crawls them and the next export contains them
 * again alongside whatever the round adds.
 *
 * What cannot come back this way is the bookkeeping the extract does not
 * carry — each club's website, the directory page bookmarks, the OSM leads
 * queue. A restored machine therefore re-walks the seed directories from
 * page one and re-imports the countries. It rediscovers rather than
 * resumes; the published clubs are simply never at risk while it does.
 *
 *   node restore.js            show what would be written
 *   node restore.js --apply    do it
 *   node restore.js --apply --force   overwrite a store that already exists
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE  = path.join(DATA_DIR, 'clubs.json');
const SITE_JSON= path.join(ROOT, 'clubs.json');

const { COUNTRIES } = require('./lib/countries');

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

function read(f){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return null; } }

/* The extract names countries in full; the store keys them by code. */
const CC_BY_NAME = new Map(Object.entries(COUNTRIES).map(([cc,[name]]) => [name.toLowerCase(), cc]));

const site = read(SITE_JSON);
if(!site || !Array.isArray(site.clubs) || !site.clubs.length){
  console.log('\n  No published clubs.json to restore from.\n');
  process.exit(1);
}

const existing = read(DB_FILE);
const already  = existing ? Object.keys(existing).length : 0;
if(already && !force){
  console.log(`\n  data/clubs.json already holds ${already} records — that is the real store,`);
  console.log('  and it knows more than the export does. Refusing to overwrite it.');
  console.log('  Run with --force if you are certain.\n');
  process.exit(1);
}

const db = {};
let unknownCountry = 0;
for(const c of site.clubs){
  const cc = CC_BY_NAME.get(String(c.country||'').toLowerCase());
  if(!cc){ unknownCountry++; continue; }

  // Keyed by name, because the extract does not carry the website. A later
  // round that finds the same club through its site files it under the host
  // instead; the export dedupes the pair by email, so it shows once.
  //
  // Two published rows can share a name — Clube de Ténis de Águeda arrived
  // once from OpenStreetMap and once from a search, each with a different
  // address. The store is keyed, so the second would land on the first and
  // one of the two would be dropped without a word. Give it its own key.
  const base = 'n:'+cc+':'+String(c.name).toLowerCase().replace(/[^a-z0-9]+/g,'');
  let key = base;
  for(let i = 2; db[key]; i++) key = base + '#' + i;

  db[key] = {
    name: c.name,
    sports: Array.isArray(c.sports) ? c.sports.slice() : [],
    contact: c.contact || '',
    email: String(c.email).toLowerCase(),
    lang: c.lang,
    country: c.country,
    cc,
    src: c.src || 'restored',
    stale: !!c.stale,
    crawled: true,
    attempts: 0,
    restored: true
  };
}

const n = Object.keys(db).length;
console.log('');
console.log('  published rows read        : ' + site.clubs.length);
console.log('  records to write           : ' + n);
if(unknownCountry) console.log('  skipped, country not in the brief : ' + unknownCountry);
if(already)        console.log('  existing records overwritten      : ' + already);
console.log('');

if(!apply){
  console.log('  Nothing written. Run with --apply to do it.');
  console.log('');
  process.exit(0);
}

if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
console.log('  Done. The next round starts from these and adds to them.');
console.log('');
