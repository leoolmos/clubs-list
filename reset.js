#!/usr/bin/env node
/**
 * reset.js — put back into the queue what was written off by a bug
 * =========================================================================
 * Two mistakes settled records permanently that should never have been:
 *
 *   - A club was marked "searched" even when the search engine had refused
 *     to answer. 3,685 of 3,891 clubs were written off that way, while a
 *     query typed by hand a minute later returned the club's own site as
 *     the first result.
 *
 *   - A captcha page was read as "this club publishes no address", which is
 *     treated as settled. Three of four English clubs checked by hand were
 *     serving a 168-byte SiteGround challenge, not a website.
 *
 * Both are fixed, but the records they touched still carry the verdict.
 * This clears it so they are tried again.
 *
 *   node reset.js            show what would be reset
 *   node reset.js --apply    do it
 * =========================================================================
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'clubs.json');
const LEADS    = path.join(DATA_DIR, 'osm-leads.json');

const apply = process.argv.includes('--apply');

function read(f){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return null; } }

const leads = read(LEADS) || {};
const db    = read(DB_FILE) || {};

/* Leads whose search never actually happened. "no result whose domain
 * matches the name" was the note the old code wrote for both a genuine
 * miss and a refusal, so they all go back — a second look at a club that
 * really has no site costs one query. */
let leadsReset = 0;
for(const k of Object.keys(leads)){
  const l = leads[k];
  if(l.searched && !l.website){
    delete l.searched;
    delete l.searchNote;
    leadsReset++;
  }
}

/* Records settled as publishing no address. Some of those pages were
 * captchas; there is no way to tell which after the fact, so all of them
 * get one more look now that challenges are recognised. */
let recordsReset = 0;
for(const k of Object.keys(db)){
  const r = db[k];
  if(r.email) continue;
  if(!r.website) continue;
  if(r.crawlNote === 'no email published' || (r.attempts||0) >= 3){
    r.attempts = 0;
    delete r.retryAfter;
    delete r.crawlNote;
    r.crawled = false;
    recordsReset++;
  }
}

console.log('');
console.log('  leads to search again      : ' + leadsReset);
console.log('  club sites to read again   : ' + recordsReset);
console.log('');

if(!apply){
  console.log('  Nothing written. Run with --apply to do it.');
  console.log('');
  process.exit(0);
}

fs.writeFileSync(LEADS, JSON.stringify(leads, null, 1));
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
console.log('  Done. The next round picks them up.');
console.log('');
