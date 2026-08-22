#!/usr/bin/env node
'use strict';
/**
 * lib/lta.js — the LTA's own venue register
 * =========================================================================
 * Britain has what most of the eighty-three countries do not: a national
 * federation that lists every affiliated venue, with the venue's own email
 * and website on the page. The Spanish RFET is the model — 45 pages of it
 * produced 366 clubs, 330 with an address — and this is the British one.
 *
 * Reaching it took some care, because two obvious routes are closed:
 *
 *   The sitemap does not carry venues. sitemapindex.xml leads to 5,900-odd
 *   pages of news, support articles and role descriptions, and not one
 *   /Venue/ among them: they are query-string URLs and were left out.
 *
 *   The map search is disallowed. robots.txt says
 *       Disallow: /*?*latitude*longitude*
 *   and a search by coordinates is exactly that shape. It works, it returns
 *   ten venues a page, and it is not ours to use. Checked 2026-08-22.
 *
 * What is allowed, and what this reads, is the plain alphabetical listing —
 * the one a visitor gets by pressing the sort button and no filter at all:
 *
 *     /play/find-a-tennis-court?fltr=y&sort=nameAsc&p=2
 *
 * No q, no latitude, no search-results in the path, so no rule touches it.
 * It paginates with p, ten to a page, and ends at p=100 with four on the
 * last: 994 venues, which is what the page's own counter says as well.
 *
 * Each venue page then gives a labelled contact card — Telephone, Email,
 * Website — in markup stable enough to read without a parser.
 *
 * What this is not is a list of clubs. It is a list of places with a court,
 * and the brief wants private clubs: "21st Walthamstow Scouts" and "3Tenn
 * Herts and Parks" are on it, and so is a venue whose published address is
 * nonmember@nonmember.com. Everything found here goes through the same
 * private-club rules as every other source, the same email tests, and then
 * the same crawl of the club's own site — which is where a venue that is
 * really a club proves it.
 *
 *   node lib/lta.js --status         where the walk has got to
 *   node lib/lta.js --pages=3        read three pages and print what they hold
 */

const path = require('path');
const fs   = require('fs');
const { getPage } = require('./http');
const { detectSports, privateClub, RE_PUBLIC_DOMAIN } = require('./classify');
const { vet } = require('./prospect');

const BASE  = 'https://www.lta.org.uk';
const LIST  = BASE + '/play/find-a-tennis-court?fltr=y&sort=nameAsc';
const VENUE = BASE + '/play/find-a-tennis-court/Venue/?VenueId=';
const STATE_FILE = path.join(__dirname, '..', 'data', 'lta.json');

/* The listing ends at p=100 today. The walk stops when a page holds nothing
 * rather than at a number, so a register that grows is followed; this is only
 * a guard against walking for ever if the site starts answering oddly. */
const MAX_PAGES = 200;

/* Addresses that are not a way to reach anybody. The first two were on the
 * register itself; the rest are the placeholders every contact form ships
 * with. An address claimed by more than five clubs is dropped downstream
 * too, but there is no reason to carry these that far. */
const RE_JUNK_EMAIL = /^(nonmember@nonmember|no-?reply@|donotreply@|example@|test@|your@|email@example|info@(mysite|website|example|domain))/i;

function textOf(html){
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ')
                     .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/&#x27;/g, "'").replace(/&#x2B;/g, '+')
                     .replace(/&amp;/g, '&').replace(/&nbsp;/gi, ' ')
                     .replace(/\s+/g, ' ');
}

/* The venue ids on one listing page, in the order the page prints them. */
function venueIds(html){
  const out = [];
  const seen = new Set();
  const re = /VenueId=([A-Za-z0-9]+)/g;
  let m;
  while((m = re.exec(String(html)))){
    if(seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/* One field of the contact card. The label sits in its own element and the
 * value follows within the same block, as a link for the three that are
 * links. Reading the href rather than the text keeps the tel: and mailto:
 * intact and skips the entity-encoded display copy. */
function cardField(html, label){
  const re = new RegExp('__header[^>]*>\\s*' + label + '\\s*<\\/div>([\\s\\S]{0,400}?)<\\/div>', 'i');
  const m = String(html).match(re);
  if(!m) return '';
  const href = m[1].match(/href="([^"]+)"/);
  return href ? href[1] : textOf(m[1]).trim();
}

function venueName(html){
  const t = (String(html).match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '';
  return textOf(t).replace(/\s*[|-]\s*LTA\s*$/i, '').trim();
}

/* Read one venue page into a record, or say why it is not one.
 *
 * A venue with no address and no website is not a lead either — the crawl
 * has nothing to open and the search already has the whole country — so it
 * is refused here rather than stored to be skipped for ever. */
async function venue(id, timeoutMs){
  const html = await getPage(VENUE + id, undefined, timeoutMs);
  if(!html) return {reason:'unreachable'};

  const name = venueName(html);
  if(!name) return {reason:'no name on the page'};

  const email = String(cardField(html, 'Email')).replace(/^mailto:/i, '').trim().toLowerCase();
  let website = String(cardField(html, 'Website')).trim();
  if(website && !/^https?:\/\//i.test(website)) website = '';
  // The register links the venue's own site, but its pages also carry the
  // LTA's sponsors — Barclays, Castore, Dunlop, Brita — and its own estate.
  // Neither is the club's website however prominent the link.
  if(website && /(^|\.)lta\.org\.uk$|ltapadel|ltatennisfoundation/i.test(hostOf(website))) website = '';

  const text   = textOf(html).slice(0, 20000);
  const sports = detectSports(name + ' ' + text);
  if(!sports.length) return {reason:'no racket sport on the page', name};

  const rec = {
    name, cc:'GB', country:'United Kingdom', lang:'English', sports,
    website: website || '', email: '', contact:'',
    src:'lta', srcPage: VENUE + id, city:'', crawled:false, attempts:0
  };

  let verdict = privateClub(rec);
  if(!verdict.ok){
    // The register names a place, not always a club: "Abbey Wood Tennis Club"
    // says what it is and "3Tenn Bushey" does not, though both have a court.
    // The venue's own website is the better witness, and it is the test the
    // prospector already applies to a stranger's site — the club has to name
    // itself like one there, show a racket sport on its own pages, and pass
    // the same private-club rules. A public court has no such site to show.
    if(!rec.website) return {reason: verdict.reason, name};
    let v2;
    try{ v2 = await vet(rec.website, 'GB', timeoutMs); }
    catch(e){ v2 = {reason:'site unreachable'}; }
    if(!v2.rec) return {reason: verdict.reason + '; its site: ' + v2.reason, name};
    // The site's name for itself beats the register's, the register's email
    // is the one the club gave its federation, and both are kept.
    rec.name   = v2.rec.name;
    rec.sports = v2.rec.sports;
    rec.website = v2.rec.website;
    verdict = {ok:true, reason:''};
  }

  if(email && !RE_JUNK_EMAIL.test(email) && /@/.test(email)){
    const host = email.split('@')[1] || '';
    // The federation's own inbox sits in the template of every venue page,
    // and a directory-wide address given to 994 clubs collapses to one row
    // on export. The same argument as the seeds, and the same rule.
    if(!/lta\.org\.uk$/i.test(host) && !RE_PUBLIC_DOMAIN.test(host)) rec.email = email;
  }

  if(!rec.email && !rec.website) return {reason:'no email and no website', name};

  // A club that publishes a freemail address has still published an address,
  // but the site is the better guide to the club's own domain, so keep both
  // and let the crawl improve on it.
  return {rec};
}

function hostOf(u){
  try{ return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
  catch(e){ return ''; }
}

function readState(){
  try{ return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch(e){ return {page:1, seen:{}, done:false, added:0, refused:{}}; }
}

function writeState(st){
  try{
    fs.mkdirSync(path.dirname(STATE_FILE), {recursive:true});
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  }catch(e){}
}

/**
 * Walk the register from where the last run stopped.
 *
 * Bookmarked by page and by venue id, so a round that runs out of time
 * resumes rather than restarting, and a venue read once is not read again
 * when the listing shifts under us — it is alphabetical, and a new venue
 * called "AAA Tennis" would otherwise push the whole walk back one place.
 */
async function importLTA(opts){
  opts = opts || {};
  const say      = opts.log || (()=>{});
  const known    = opts.knownHosts || new Set();
  const deadline = opts.deadline || (Date.now() + 120000);
  const timeout  = opts.timeoutMs || 9000;
  const st       = opts.state || readState();
  st.seen = st.seen || {};
  st.refused = st.refused || {};

  const maxPages = opts.maxPages || MAX_PAGES;
  const out = {pages:0, scanned:0, added:[], done:!!st.done, state:st};

  while(Date.now() < deadline && st.page <= MAX_PAGES && !st.done && out.pages < maxPages){
    const html = await getPage(LIST + '&p=' + st.page, undefined, timeout);
    if(!html) break;                       // a bad page is not the end of the list
    const ids = venueIds(html);
    out.pages++;

    if(!ids.length){                       // past the last page: 994 venues, p=100
      st.done = true;
      out.done = true;
      say(`lta: register walked to the end — ${Object.keys(st.seen).length} venues seen`);
      break;
    }

    for(const id of ids){
      if(Date.now() >= deadline) break;
      if(st.seen[id]) continue;
      st.seen[id] = 1;
      out.scanned++;

      let v;
      try{ v = await venue(id, timeout); }
      catch(e){ v = {reason:'read failed: ' + e.message}; }

      if(!v.rec){
        const kind = String(v.reason).replace(/ *"[^"]*"/, '').trim();
        st.refused[kind] = (st.refused[kind] || 0) + 1;
        continue;
      }
      const host = hostOf(v.rec.website);
      if(host && known.has(host)) continue; // another engine found it first
      if(host) known.add(host);
      out.added.push(v.rec);
      st.added = (st.added || 0) + 1;
      say(`lta: ${v.rec.name}${v.rec.email ? ' -> ' + v.rec.email : (v.rec.website ? ' -> ' + v.rec.website : '')}`);
    }

    // Only past the page once every venue on it has been read, so a deadline
    // in the middle of a page resumes on the same page rather than skipping
    // the rest of it.
    if(ids.every(id => st.seen[id])) st.page++;
  }

  if(!opts.state) writeState(st);
  return out;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
if(require.main === module){
  const arg = process.argv.slice(2).join(' ');
  if(/--status/.test(arg)){
    const st = readState();
    console.log(`\n  LTA venue register`);
    console.log(`    page      ${st.page}${st.done ? ' (walked to the end)' : ''}`);
    console.log(`    venues    ${Object.keys(st.seen || {}).length} read, ${st.added || 0} kept`);
    const top = Object.entries(st.refused || {}).sort((a,b)=>b[1]-a[1]).slice(0, 6);
    if(top.length) console.log(`    turned down  ` + top.map(([r,n])=>`${r} ×${n}`).join(', '));
    console.log('');
  } else {
    const pages = Math.max(1, parseInt((arg.match(/--pages=(\d+)/) || [])[1] || '1', 10));
    const st = readState();
    importLTA({
      state: st,
      maxPages: pages,
      deadline: Date.now() + pages * 180000,
      log: m => console.log('  ' + m)
    }).then(r => {
      writeState(st);
      console.log(`\n  ${r.pages} pages, ${r.scanned} venues read, ${r.added.length} kept`);
      const top = Object.entries(st.refused || {}).sort((a,b)=>b[1]-a[1]).slice(0, 6);
      if(top.length) console.log(`  turned down: ` + top.map(([k,n])=>`${k} ×${n}`).join(', '));
      console.log('');
    }).catch(e => { console.error('  failed: ' + e.message); process.exit(1); });
  }
}

module.exports = { importLTA, venue, venueIds, cardField, readState, writeState, LIST, VENUE };
