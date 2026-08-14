#!/usr/bin/env node
'use strict';
/**
 * build-cities.js — generate lib/cities.json from GeoNames
 * =========================================================================
 * Every city of 20,000 people or more, for every country in the brief,
 * ordered biggest first. This is what the prospector walks: each city gets
 * every search term, so "clube de tênis Santos contato" happens as surely
 * as "tennis club London contact".
 *
 * Source: https://download.geonames.org/export/dump/cities15000.zip
 * (GeoNames, CC-BY 4.0 — the footer of the page credits them.)
 *
 *   1. download cities15000.zip, unzip it
 *   2. node scripts/build-cities.js path/to/cities15000.txt
 *   3. commit lib/cities.json
 *
 * Rules applied on the way through:
 *   - population >= 20,000, country in lib/countries.js
 *   - one entry per name per country (the bigger one wins)
 *   - names under 5 characters are kept for searching but the vet will not
 *     accept them as proof of place (see lib/prospect.js) — "York" proves
 *     nothing on a page about New York
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const { COUNTRIES } = require('../lib/countries');

const src = process.argv[2];
if(!src || !fs.existsSync(src)){
  console.error('usage: node scripts/build-cities.js path/to/cities15000.txt');
  process.exit(1);
}

const MIN_POP = 20000;
const out = {};           // cc -> [{n, p}] then flattened to names
const seen = {};          // cc -> Set of lowercased names

let rows = 0, kept = 0;
for(const line of fs.readFileSync(src, 'utf8').split('\n')){
  if(!line) continue;
  rows++;
  const f = line.split('\t');
  const name = f[1];            // main name, with accents — what local pages use
  const cc   = f[8];
  const pop  = parseInt(f[14], 10) || 0;
  if(!COUNTRIES[cc] || pop < MIN_POP || !name) continue;

  const key = name.toLowerCase();
  const bag = out[cc] || (out[cc] = []);
  const dup = (seen[cc] || (seen[cc] = new Map()));
  const prev = dup.get(key);
  if(prev !== undefined){
    if(bag[prev].p < pop){ bag[prev] = {n: name, p: pop}; }
    continue;
  }
  dup.set(key, bag.length);
  bag.push({n: name, p: pop});
  kept++;
}

const final = {};
let total = 0;
for(const cc of Object.keys(out).sort()){
  final[cc] = out[cc].sort((a,b) => b.p - a.p).map(c => c.n);
  total += final[cc].length;
}

const dest = path.join(__dirname, '..', 'lib', 'cities.json');
fs.writeFileSync(dest, JSON.stringify(final));
console.log(`${rows} GeoNames rows -> ${total} cities >= ${MIN_POP} people across ${Object.keys(final).length} countries`);
for(const cc of ['BR','US','ES','GB','IN','MX','AR','PT']){
  if(final[cc]) console.log(`  ${cc}: ${final[cc].length} cities, biggest: ${final[cc].slice(0,3).join(', ')}`);
}
console.log(`written to ${dest}`);
