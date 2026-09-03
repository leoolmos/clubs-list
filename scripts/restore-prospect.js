#!/usr/bin/env node
/**
 * restore-prospect.js — give the prospector its memory back
 * =========================================================================
 * data/prospect.json is the ledger of every search the prospector has run:
 * which term has been asked of which city, per country. It is not in git,
 * and on 2026-09-03 it went with a fresh clone. The clubs came back from
 * the published clubs.json (restore.js), but the ledger did not, and the
 * prospector started again from the biggest city of every country as if
 * 34,000 searches had never happened.
 *
 * Most of the ledger is recoverable all the same, because status.json IS
 * in git, and it carries, per country, every city searched with how many
 * of its terms were asked — that is what the coverage tab draws from. The
 * queries are deterministic (lib/prospect.js queriesFor), so "Madrid, 3
 * searches" is exactly "the first three of Madrid's queries are done".
 *
 * This reads a status.json and marks those queries done in the ledger,
 * keeping anything the ledger already holds: the union, never a rewind.
 * What it cannot recover is which query was refused and deferred — nothing
 * is lost by that, only asked once more.
 *
 *   node scripts/restore-prospect.js --from=git:3066333        show what would change
 *   node scripts/restore-prospect.js --from=git:3066333 --apply
 *   node scripts/restore-prospect.js --from=path/to/status.json --apply
 *
 * Run it with the collector stopped: the daemon holds the ledger in memory
 * for the length of a phase and writes it back at the end, over this.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'prospect.json');
const { COUNTRIES } = require('../lib/countries');
const prospect = require('../lib/prospect');

const args  = process.argv.slice(2);
const apply = args.includes('--apply');
const from  = (args.find(a => a.startsWith('--from=')) || '--from=status.json').slice(7);

function read(f){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return null; } }

let status;
if(from.startsWith('git:')){
  const rev = from.slice(4);
  try{
    status = JSON.parse(execFileSync('git', ['show', `${rev}:status.json`],
      {cwd: ROOT, encoding: 'utf8', maxBuffer: 64*1024*1024}));
  }catch(e){
    const first = String(e.stderr || e.message).trim().split(/\r?\n/)[0];
    console.error(`\n  Could not read status.json at ${rev} from git: ${first}\n`);
    process.exit(1);
  }
} else {
  status = read(path.isAbsolute(from) ? from : path.join(ROOT, from));
  if(!status){ console.error(`\n  ${from} is not a readable status.json.\n`); process.exit(1); }
}
if(!status.perCountry){
  console.error('\n  That status.json carries no perCountry section — nothing to restore from.\n');
  process.exit(1);
}

const CC_BY_NAME = new Map(Object.entries(COUNTRIES).map(([cc,[name]]) => [name, cc]));
const state = read(STATE_FILE) || {};

function citiesOf(st){ return Object.keys(st.cityStats || {}).filter(k => k !== '').length; }
function summary(s){
  let cities = 0, queries = 0, found = 0;
  for(const [k, st] of Object.entries(s)){
    if(k.startsWith('__')) continue;
    cities += citiesOf(st); queries += (st.queriesDone || []).length; found += st.found || 0;
  }
  return {cities, queries, found};
}
const before = summary(state);

let restoredCountries = 0, unknownCity = 0, addedQueries = 0;
const lastSeen = [];
const lines = [];
for(const [cname, r] of Object.entries(status.perCountry)){
  const pr = r.prospect;
  if(!pr) continue;
  const cc = pr.cc || CC_BY_NAME.get(cname);
  if(!cc || !COUNTRIES[cc]) continue;

  // The country's queries, grouped by the city they ask about — '' for the
  // country-wide set — in the order they are asked.
  const byCity = new Map();
  for(const x of prospect.queriesFor(cc)){
    const k = x.city || '';
    if(!byCity.has(k)) byCity.set(k, []);
    byCity.get(k).push(x.q);
  }

  const st = state[cc] || (state[cc] = {queriesDone: [], found: 0});
  const done = new Set(st.queriesDone || []);
  const cs = st.cityStats || (st.cityStats = {});
  const wasCities = citiesOf(st), wasDone = done.size;

  const rows = (pr.cityStats || []).map(x => Array.isArray(x)
    ? {n: x[0], s: x[1] || 0, f: x[2] || 0}
    : {n: x.n, s: x.s || 0, f: x.f || 0});
  if(pr.countrywide) rows.push({n: '', s: pr.countrywide.s || 0, f: pr.countrywide.f || 0});

  for(const row of rows){
    if(!row.s) continue;                       // a city with emails but no search yet
    const list = byCity.get(row.n);
    if(!list){
      // The city named after its country mirrors the country-wide set and
      // has no queries of its own; anything else is a name the list no
      // longer carries.
      if(row.n !== prospect.twinCity(cc)) unknownCity++;
      continue;
    }
    // s can exceed the term count on a ledger that once double-counted;
    // the first min(s, terms) queries are the ones that were asked.
    for(let i = 0; i < Math.min(row.s, list.length); i++){
      if(!done.has(list[i])){ done.add(list[i]); addedQueries++; }
    }
    const c = cs[row.n] || (cs[row.n] = {s: 0, f: 0});
    c.f = Math.max(c.f || 0, row.f || 0);
  }

  // Searches per city, recounted from the ledger itself so nothing is
  // credited twice whichever side it came from.
  for(const [city, list] of byCity){
    const s = list.reduce((n, q) => n + (done.has(q) ? 1 : 0), 0);
    if(s) cs[city] = {s, f: (cs[city] || {}).f || 0};
  }
  st.queriesDone = Array.from(done);
  st.found = Object.values(cs).reduce((n, v) => n + (v.f || 0), 0);
  if(pr.last && (!st.last || pr.last > st.last)) st.last = pr.last;
  if(pr.last) lastSeen.push(pr.last);

  if(done.size !== wasDone){
    restoredCountries++;
    const total = (prospect.CITIES[cc] || []).length;
    lines.push('  ' + cname.padEnd(28) +
      ' cities ' + String(wasCities).padStart(5) + ' -> ' + String(citiesOf(st)).padStart(5) + ' of ' + String(total).padStart(5) +
      '   searches ' + String(wasDone).padStart(5) + ' -> ' + String(done.size).padStart(5));
  }
}

// The pass this ledger is on. Pass 1 began when the prospector first ran,
// which the oldest "last touched" in the published status approximates.
if(!state.__pass){
  lastSeen.sort();
  state.__pass = {n: 1, startedAt: lastSeen[0] || new Date().toISOString(), history: []};
}

const after = summary(state);
console.log('');
console.log('  from                       : ' + from);
console.log('  countries restored         : ' + restoredCountries);
console.log('  searches marked done       : ' + before.queries + ' -> ' + after.queries + '  (+' + addedQueries + ')');
console.log('  cities searched            : ' + before.cities + ' -> ' + after.cities);
console.log('  clubs credited             : ' + before.found + ' -> ' + after.found);
if(unknownCity) console.log('  city rows not in the list  : ' + unknownCity + ' (skipped)');
console.log('  pass                       : ' + state.__pass.n + ', since ' + state.__pass.startedAt);
console.log('');
lines.sort().forEach(l => console.log(l));
console.log('');

if(!apply){
  console.log('  Nothing written. Run with --apply to do it — with the collector stopped.');
  console.log('');
  process.exit(0);
}
const lock = read(path.join(ROOT, 'data', 'collector.lock'));
if(lock && lock.pid){
  let alive = true;
  try{ process.kill(lock.pid, 0); }catch(e){ alive = false; }
  if(alive){
    console.log('  Not written: a collector is running (pid ' + lock.pid + ') and would overwrite this at the end of its phase.');
    console.log('  Stop it first:  powershell -File start-collector.ps1 -Stop');
    console.log('');
    process.exit(1);
  }
}
fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1));
fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
console.log('  Done. The next round carries on from here.');
console.log('');
