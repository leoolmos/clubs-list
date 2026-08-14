#!/usr/bin/env node
'use strict';
/**
 * backfill-cities.js — give the existing records their city
 * =========================================================================
 * The per-city email counters only count records that carry a city, and
 * everything collected before 2026-08-14 carries none. This walks the
 * store once and fills the field in from what is already known:
 *
 *   1. the town OpenStreetMap recorded on the lead that became the record
 *   2. the city's own name inside the club's name — "Lagos Lawn Tennis
 *      Club" names its city, and so do half the clubs in the store
 *   3. the lead's coordinates, snapped to the nearest listed city within
 *      30 km, when GeoNames coordinates are available
 *
 * A city is only ever set to a name from lib/cities.json, in the record's
 * own country, because that is what the coverage tab joins on. Nothing is
 * created, merged or deleted — records that cannot be placed stay as they
 * are, and the email-level dedupe on publish is untouched.
 *
 *   node scripts/backfill-cities.js <data-dir> [cities15000.txt]
 *
 * Run it with the collector stopped: it rewrites data/clubs.json.
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2];
const geoTxt  = process.argv[3];
if(!dataDir || !fs.existsSync(path.join(dataDir, 'clubs.json'))){
  console.error('usage: node scripts/backfill-cities.js <data-dir with clubs.json> [cities15000.txt]');
  process.exit(1);
}

const CITIES = require('../lib/cities.json');

const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const flat = s => ' ' + norm(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const slug = (cc, name) => 'n:' + cc + ':' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');

/* Per country: exact-name lookup, and the name list longest-first so
 * "San Isidro" wins over any shorter city hiding inside it. */
const byNorm = {}, byLen = {};
for(const [cc, list] of Object.entries(CITIES)){
  byNorm[cc] = new Map(list.map(c => [norm(c), c]));
  byLen[cc] = list
    .map(c => ({c, f: flat(c).trim()}))
    .filter(x => x.f.length >= 4)
    .sort((a, b) => b.f.length - a.f.length);
}

/* Coordinates, when the GeoNames dump is at hand, for the nearest-city pass */
const coords = {};
if(geoTxt && fs.existsSync(geoTxt)){
  for(const line of fs.readFileSync(geoTxt, 'utf8').split('\n')){
    const f = line.split('\t');
    const cc = f[8], name = f[1];
    if(!byNorm[cc] || !byNorm[cc].has(norm(name))) continue;
    (coords[cc] = coords[cc] || []).push({c: byNorm[cc].get(norm(name)), lat: +f[4], lon: +f[5]});
  }
}
function nearest(cc, lat, lon){
  let best = null, bestKm = 30;
  for(const p of coords[cc] || []){
    const dLat = (p.lat - lat) * 111;
    const dLon = (p.lon - lon) * 111 * Math.cos(lat * Math.PI / 180);
    const km = Math.sqrt(dLat*dLat + dLon*dLon);
    if(km < bestKm){ bestKm = km; best = p.c; }
  }
  return best;
}

const db    = JSON.parse(fs.readFileSync(path.join(dataDir, 'clubs.json'), 'utf8'));
const leads = fs.existsSync(path.join(dataDir, 'osm-leads.json'))
  ? JSON.parse(fs.readFileSync(path.join(dataDir, 'osm-leads.json'), 'utf8')) : {};

let viaTown = 0, viaName = 0, viaCoords = 0, unplaced = 0, already = 0, emailsMapped = 0;
for(const rec of Object.values(db)){
  if(rec.city){ already++; continue; }
  const cc = rec.cc;
  if(!byNorm[cc]){ unplaced++; continue; }

  const lead = leads[slug(cc, rec.name)];
  let city = '';

  if(lead && lead.town){
    city = byNorm[cc].get(norm(lead.town)) || '';
    if(city) viaTown++;
  }
  if(!city){
    const hay = flat(rec.name);
    for(const {c, f} of byLen[cc]){
      if(hay.includes(' ' + f + ' ')){ city = c; viaName++; break; }
    }
  }
  if(!city && lead && lead.lat != null && lead.lon != null){
    city = nearest(cc, lead.lat, lead.lon) || '';
    if(city) viaCoords++;
  }

  if(city){
    rec.city = city;
    if(rec.email) emailsMapped++;
  } else {
    unplaced++;
  }
}

const tmp = path.join(dataDir, 'clubs.json.tmp');
fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
fs.renameSync(tmp, path.join(dataDir, 'clubs.json'));

const total = Object.keys(db).length;
console.log(`${total} records: ${viaTown} placed by the lead's town, ${viaName} by the city in the club's name, ` +
            `${viaCoords} by coordinates, ${already} already had one, ${unplaced} could not be placed.`);
console.log(`${emailsMapped} records with an email now carry their city.`);
