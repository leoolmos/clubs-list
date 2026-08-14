'use strict';
/**
 * mine.js — find club domains that no directory lists
 * =========================================================================
 * Every directory walk, search query and map lookup shares one blind spot:
 * a club nobody has written down anywhere. But a club with a website has a
 * TLS certificate, and every certificate ever issued is in the public
 * Certificate Transparency logs. crt.sh exposes those logs to a plain HTTP
 * query, free, no key.
 *
 * So this asks for domain names that carry a club word — padel, tennisclub,
 * clubdetenis — under the country-code TLDs of the brief. The TLD makes the
 * country certain, and the vet in prospect.js then reads each page and
 * applies the same sport, private-club and listing rules as everything
 * else. What survives goes into the store with no email, and the crawl
 * turns it into a contact like any other record.
 *
 * Wikidata rides along in the same phase: one SPARQL query for every item
 * typed as a sports club whose sport is tennis, padel or squash, with its
 * country and official website. Items without a website become leads for
 * the search phase instead.
 *
 * Both services are free and rate-limited by donated hardware, so the
 * queries are spaced, capped per round, and cached in data/mine-state.json.
 * =========================================================================
 */

const fs   = require('fs');
const path = require('path');
const { isWanted, nameOf, langOf, ccFromHost } = require('./countries');
const { privateClub } = require('./classify');
const { vet } = require('./prospect');
const { UA, sleep } = require('./http');
const { keyFor } = require('./osm');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mine-state.json');

/* How long an answer is trusted before the word is asked again. crt.sh
 * returns the freshest certificates first, so a weekly re-ask is how newly
 * built club sites surface days after they go live. */
const REFRESH_MS  = 7 * 24 * 60 * 60 * 1000;
const WIKIDATA_MS = 30 * 24 * 60 * 60 * 1000;

/* crt.sh is one donated PostgreSQL instance and each %word% query is a real
 * scan for it. A couple per round is plenty — the vetting of what they
 * return is the slow part anyway.
 *
 * The query form matters: crt.sh accepts %word% and nothing fancier —
 * %word%.uy answers "Unsupported use of '%'". So the word alone is asked
 * for, and the country is read off each host's TLD afterwards, which is
 * work the TLD_TO_CC table already does. */
const QUERIES_PER_ROUND = 2;

const WORDS = [
  'padel', 'tennisclub', 'squashclub', 'racquetclub',
  'clubdetenis', 'tenisclub', 'clubdepadel', 'tenisclube', 'clubedetenis'
];

/* Certificate SANs name the plumbing as well as the site. The label is
 * dropped, the host behind it kept. */
const RE_PLUMBING = /^(cpanel|webmail|mail|ftp|autodiscover|autoconfig|cpcalendars|cpcontacts|smtp|pop3?|imap|ns\d*|server\d*|host\d*|vps\d*|mx\d*|staging|test|dev)\./i;

function readJSON(f, fallback){
  if(!fs.existsSync(f)) return fallback;
  try{ return JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ return fallback; }
}
function writeJSON(f, o){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
  fs.renameSync(tmp, f);
}

async function fetchJSON(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), ms || 45000);
  try{
    const r = await fetch(url, {headers:{'User-Agent':UA, 'Accept':'application/json'}, signal:ctl.signal});
    if(!r.ok) return null;
    return await r.json();
  }catch(e){ return null; }
  finally{ clearTimeout(t); }
}

/* One crt.sh query -> candidate hosts with their countries, filtered hard
 * before a single page is opened. Only hosts on an unambiguous ccTLD of the
 * brief survive: a .com proves nothing about where the club is, and the
 * vanity TLDs are excluded by TLD_TO_CC already. */
async function queryWord(word, knownHosts){
  const rows = await fetchJSON('https://crt.sh/?q=' + encodeURIComponent('%' + word + '%') + '&output=json', 60000);
  if(!Array.isArray(rows)) return null;

  const out = new Map();          // host -> cc
  for(const row of rows){
    for(let h of String(row.name_value || '').split(/\n/)){
      h = h.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\d*\./, '');
      h = h.replace(RE_PLUMBING, '');
      // identities are usually hostnames but not always — emails and
      // free-text names appear too, and neither is somewhere to crawl
      if(!h || !h.includes('.') || !/^[a-z0-9.-]+$/.test(h)) continue;
      if(!h.includes(word)) continue;
      if(knownHosts.has(h)) continue;
      const cc = ccFromHost(h);
      if(!cc || !isWanted(cc)) continue;
      out.set(h, cc);
    }
  }
  return Array.from(out, ([host, cc]) => ({host, cc}));
}

/* ------------------------------------------------------------------ *
 * Wikidata — the clubs notable enough that somebody catalogued them
 * ------------------------------------------------------------------ */
const SPORT_Q = {Q847: 'Tennis', Q1582389: 'Padel', Q133201: 'Squash'};

/* No subclass-tree walk: recursing P279* under "sports club" timed the
 * query out, and so did asking for all three sports at once. One sport per
 * query, websites required — people carry P27 citizenship rather than P17,
 * so what comes back is organisations and venues, and the same name gates
 * that guard every other source drop the tournaments and stadiums. The
 * query service answers 502 under load; each sport keeps its own timestamp
 * and is simply asked again on a later round until it answers. */
function sparqlFor(qid){
  return `SELECT ?item ?itemLabel ?web ?ccode WHERE {
  ?item wdt:P641 wd:${qid} ; wdt:P17 ?country ; wdt:P856 ?web .
  ?country wdt:P297 ?ccode .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,es,pt". }
} LIMIT 10000`;
}

async function mineWikidata(db, state, knownHosts, say){
  const st = state.wikidata || (state.wikidata = {});
  st.sports = st.sports || {};

  // The query service goes down for hours at a stretch, answering 502 to
  // everything. Retrying every round then costs three 70-second timeouts
  // per round — a sixth of the whole round spent waiting on a dead service.
  // After a pass where nothing answered, it is left alone for four hours.
  if(st.failedAt && Date.now() - Date.parse(st.failedAt) < 4*60*60*1000) return {added: 0, leads: 0};

  let added = 0, asked = 0, answered = 0;
  for(const [qid, sportName] of Object.entries(SPORT_Q)){
    const at = st.sports[qid];
    if(at && Date.now() - Date.parse(at) < WIKIDATA_MS) continue;

    asked++;
    const data = await fetchJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparqlFor(qid)), 70000);
    if(!data || !data.results || !Array.isArray(data.results.bindings)){
      say(`mine wikidata: the query service did not answer for ${sportName}, will retry`);
      continue;                                   // no timestamp — asked again after the pause
    }
    answered++;

    let sportAdded = 0;
    for(const b of data.results.bindings){
      const cc = (b.ccode && b.ccode.value || '').toUpperCase();
      const name = b.itemLabel && b.itemLabel.value || '';
      const web = b.web && b.web.value || '';
      if(!isWanted(cc) || !web) continue;
      if(!name || /^Q\d+$/.test(name)) continue;   // no label in our languages

      const rec = {
        name, cc, country: nameOf(cc), lang: langOf(cc),
        sports: [sportName], website: '', email: '',
        contact: '', src: 'wikidata', srcPage: 'https://www.wikidata.org',
        crawled: false, attempts: 0
      };
      if(!privateClub({name, website: web}).ok) continue;

      let host;
      try{ const u = new URL(web); host = u.hostname.replace(/^www\./, '').toLowerCase(); rec.website = u.origin; }
      catch(e){ continue; }
      if(knownHosts.has(host)) continue;
      const k = keyFor(rec);
      if(db[k]){
        db[k].sports = Array.from(new Set((db[k].sports||[]).concat(sportName)));
        continue;
      }
      db[k] = rec;
      knownHosts.add(host);
      sportAdded++;
    }

    st.sports[qid] = new Date().toISOString();
    st.added = (st.added || 0) + sportAdded;
    added += sportAdded;
    say(`mine wikidata: ${data.results.bindings.length} catalogued ${sportName} entries, +${sportAdded} clubs with a website`);
  }

  if(asked && !answered) st.failedAt = new Date().toISOString();
  else if(answered) delete st.failedAt;
  return {added, leads: 0};
}

/* ------------------------------------------------------------------ *
 * One slice of mining, called by the daemon each round
 * ------------------------------------------------------------------ */
async function run(db, deadline, log){
  const say = log || (()=>{});
  const state = readJSON(STATE_FILE, {});

  const knownHosts = new Set();
  for(const r of Object.values(db)){
    if(!r.website) continue;
    try{ knownHosts.add(new URL(r.website).hostname.replace(/^www\./, '').toLowerCase()); }catch(e){}
  }

  let queried = 0, vetted = 0, added = 0, wikidataAdded = 0;

  try{
    const w = await mineWikidata(db, state, knownHosts, say);
    wikidataAdded = w.added;
    added += w.added;
  }catch(e){ say('mine wikidata failed: ' + e.message); }
  writeJSON(STATE_FILE, state);

  for(const word of WORDS){
    if(Date.now() > deadline) break;
    const st = state[word] || (state[word] = {});

    if(!(st.pending || []).length){
      if(st.at && Date.now() - Date.parse(st.at) < REFRESH_MS) continue;   // asked recently, nothing left to vet
      if(queried >= QUERIES_PER_ROUND) continue;

      queried++;
      const found = await queryWord(word, knownHosts);
      await sleep(4000);                       // crt.sh is one donated database
      if(found === null){
        // The service declining to answer is not this word being empty.
        st.err = (st.err || 0) + 1;
        say(`mine: crt.sh did not answer for "${word}", will retry`);
        if(st.err >= 3){ st.at = new Date().toISOString(); st.err = 0; }  // stop hammering; ask again next week
        continue;
      }
      st.err = 0;
      st.at = new Date().toISOString();
      st.found = found.length;
      st.pending = found.slice(0, 600);
      say(`mine: "${word}" -> ${found.length} candidate domains on brief ccTLDs`);
    }

    while((st.pending || []).length){
      if(Date.now() > deadline) break;
      const cand = st.pending.shift();
      if(!cand || !cand.host || knownHosts.has(cand.host)) continue;
      vetted++;
      let v;
      try{ v = await vet('https://' + cand.host, cand.cc, 9000); }
      catch(e){ v = {reason: 'vet failed: ' + e.message}; }
      if(v.rec){
        v.rec.src = 'mine';
        const k = keyFor(v.rec);
        if(!db[k]){
          db[k] = v.rec;
          knownHosts.add(cand.host);
          added++;
          st.added = (st.added || 0) + 1;
          say(`mine: ${v.rec.name} (${nameOf(cand.cc)}) -> ${v.rec.website}`);
        }
      }
    }
    writeJSON(STATE_FILE, state);
  }

  writeJSON(STATE_FILE, state);
  return {queried, vetted, added, wikidataAdded};
}

module.exports = { run, queryWord, WORDS };
