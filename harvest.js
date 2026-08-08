#!/usr/bin/env node
/**
 * harvest.js — point the collector at one directory, right now
 * =========================================================================
 * Use this when you have just found a listing page and want to see what it
 * yields without waiting for the next hourly round.
 *
 *   node harvest.js <listing-url> <COUNTRY> [--pages=25]
 *
 * Example:
 *   node harvest.js "https://example-federation.es/clubes" ES
 *
 * The URL is added to seeds.txt as well, so the daemon keeps walking it on
 * later rounds — a hundred-page directory is not finished in one go, and
 * the page it stopped on is bookmarked.
 *
 * This used to be a second implementation of the crawler. It had drifted
 * from the daemon's: it was still forcing utf8 on windows-1252 pages, so
 * every accented club name it collected came out corrupted. Now both run
 * the same code.
 *
 * Node 18+. Zero dependencies.
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { COUNTRIES, isWanted, nameOf } = require('./lib/countries');

const ROOT       = __dirname;
const SEEDS_FILE = path.join(ROOT, 'seeds.txt');

function addSeed(cc, url){
  let txt = fs.existsSync(SEEDS_FILE) ? fs.readFileSync(SEEDS_FILE,'utf8') : '';
  if(txt.includes(url)){
    console.log(`  already in seeds.txt — the daemon is working through it`);
    return false;
  }
  const stamp = new Date().toISOString().slice(0,10);
  if(txt && !txt.endsWith('\n')) txt += '\n';
  txt += `\n# added by harvest.js on ${stamp}\n${cc}  ${url}\n`;
  fs.writeFileSync(SEEDS_FILE, txt);
  console.log(`  added to seeds.txt`);
  return true;
}

const args = process.argv.slice(2);
const url  = args[0];
const cc   = (args[1]||'').toUpperCase();
const pages= (args.find(a=>a.startsWith('--pages='))||'').split('=')[1] || '25';

if(!url || !cc || !/^https?:\/\//i.test(url) || !isWanted(cc)){
  console.log(`
Point the collector at one directory, now

  node harvest.js <listing-url> <COUNTRY> [--pages=25]

Example:
  node harvest.js "https://example-federation.es/clubes" ES

The page is added to seeds.txt and worked immediately. What it finds lands
in data/clubs.json alongside everything else, and clubs.json — the file the
web page reads — is rewritten at the end.

What to point it at, richest first:
  1. Booking platform club indexes   — best coverage for padel
  2. National federation club lists  — tennis, padel and squash each have one
  3. Regional federation lists       — in Spain these hold more than the national body
  4. Padel and tennis portals with club directories
  5. League sites — a fixture list is a list of clubs with a secretary's email

Country codes: ${Object.keys(COUNTRIES).join(' ')}
`);
  process.exit(url || cc ? 1 : 0);
}

console.log(`\n  ${cc} ${nameOf(cc)}  ${url}\n`);
addSeed(cc, url);

// One round, no OSM step, and enough page budget to actually get through the
// directory rather than stopping after the daemon's usual slice.
console.log(`  working it now...\n`);
try{
  execFileSync(process.execPath, [path.join(ROOT,'daemon.js'),'once'], {
    cwd: ROOT, stdio: 'inherit',
    env: Object.assign({}, process.env, {OSM:'off', PAGES_PER_TICK: String(pages)})
  });
}catch(e){
  process.exitCode = 1;
}
