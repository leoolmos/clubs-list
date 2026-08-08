'use strict';
/**
 * OpenStreetMap importer — country-wide club discovery, no account, no key
 * =========================================================================
 * Federation directories only exist where there is a federation with a
 * website. That covers Spain, the UK, Brazil and a dozen others well, and
 * leaves Tuvalu, Palau, Guinea-Bissau and thirty more with nothing at all.
 *
 * OSM covers every country in the list. It is queried through Overpass, a
 * public read-only endpoint: no registration, no key, no card, no quota to
 * exceed — the same thing any map editor uses. What comes back is a club
 * name, and often the club's own website, which is what the crawler needs
 * to go and find the email.
 *
 * Only places that carry a website or an email are kept. A named court with
 * neither is a dead end for this job, and keeping them would bury the queue
 * in records that can never produce a contact.
 *
 *   node lib/osm.js ES            import Spain
 *   node lib/osm.js ES PT BR      several
 *   node lib/osm.js --all         every country in the brief, by priority
 *   node lib/osm.js --status      what has been imported
 * =========================================================================
 */

const fs   = require('fs');
const path = require('path');
const { COUNTRIES, PRIORITY, isWanted, nameOf, langOf } = require('./countries');
const { sportsFromTag, detectSports, privateClub } = require('./classify');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const DB_FILE   = path.join(DATA_DIR, 'clubs.json');
const STATE_FILE= path.join(DATA_DIR, 'osm-state.json');
const LEADS_FILE= path.join(DATA_DIR, 'osm-leads.json');   // real clubs, no contact tagged yet

/* Public Overpass instances. Tried in order; if one is busy or rate-limiting
 * the next is used. All are the same database. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const UA = 'RacketClubResearch/1.0 (club directory research; contact: set-your-email@example.com)';

/* Overpass is a shared free service. One country at a time, a pause between
 * them, and a long timeout so a big country finishes rather than being
 * retried from scratch. */
const QUERY_TIMEOUT_S = 180;
const HTTP_TIMEOUT_MS = 240000;
const PAUSE_MS        = 8000;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* ------------------------------------------------------------------ *
 * The query
 * ------------------------------------------------------------------ *
 * Everything in the country that plays one of the three sports and carries
 * a name, in any of the shapes OSM uses for a club: a sports centre, a
 * pitch, a club tag, or a leisure=club. `out center` gives one coordinate
 * for ways and relations without the full geometry, which keeps the
 * response small.
 */
/* One branch at a time. A union of both over a whole country was heavy enough
 * that overpass-api.de answered 504, and the mirrors answered 200 with a
 * truncated list — which looked like "this country has two clubs" rather than
 * like a failure. Two cheap queries beat one expensive one. */
function buildQuery(cc, branch){
  const head = `[out:json][timeout:${QUERY_TIMEOUT_S}];\narea["ISO3166-1"="${cc}"][admin_level=2]->.c;\n`;
  if(branch === 'club'){
    // club=sport would pull in every judo, football and sailing club in the
    // country — on the Malta test that was most of the response.
    return head + `nwr(area.c)["club"~"^(tennis|padel|squash|racquet)$"]["name"];\nout tags center;`;
  }
  // sport=* is a semicolon-separated list, so match the value anywhere in it
  return head + `nwr(area.c)["sport"~"(^|;)(tennis|padel|paddle_tennis|padel_tennis|squash)(;|$)"]["name"];\nout tags center;`;
}

/**
 * Run one query across the mirrors until one answers completely.
 *
 * The important part is `remark`. Overpass signals a timed-out or
 * out-of-memory query by returning HTTP 200 with however many elements it
 * managed plus a remark saying so. Treating that as success is how a country
 * silently ends up with a fraction of its clubs and gets marked done.
 */
async function runQuery(query){
  const body = 'data=' + encodeURIComponent(query);
  let lastErr = '';

  for(const url of ENDPOINTS){
    // 429 means the rate limiter, not a broken mirror. Falling straight
    // through to the next one costs us the primary's fresher data, so wait
    // it out here first.
    for(let attempt=0; attempt<3; attempt++){
      if(attempt) await sleep(attempt * 15000);

      const ctl = new AbortController();
      const timer = setTimeout(()=>ctl.abort(), HTTP_TIMEOUT_MS);
      try{
        const r = await fetch(url, {
          method:'POST',
          headers:{'User-Agent':UA,'Content-Type':'application/x-www-form-urlencoded'},
          body, signal: ctl.signal
        });
        if(r.status === 429 || r.status === 503 || r.status === 504){
          lastErr = 'busy ('+r.status+')';
          continue;
        }
        if(!r.ok){ lastErr = 'HTTP '+r.status; break; }

        const text = await r.text();
        let json;
        try{ json = JSON.parse(text); }
        catch(e){ lastErr = 'non-JSON response'; break; }

        if(json.remark && /timed out|out of memory|error/i.test(json.remark)){
          lastErr = 'server cut the query short: ' + json.remark.slice(0,80);
          continue;                       // partial data — do not accept it
        }
        if(!Array.isArray(json.elements)){ lastErr = 'no elements in response'; break; }
        return {elements: json.elements, endpoint: url};
      }catch(e){
        lastErr = e.name === 'AbortError' ? 'timed out' : e.message;
      }finally{
        clearTimeout(timer);
      }
    }
    await sleep(3000);
  }
  return {elements: null, error: lastErr};
}

/* Both branches, deduplicated by OSM id. If either branch fails outright the
 * country is reported as failed rather than half-imported. */
async function overpass(cc){
  const seen = new Map();
  let endpoint = '';

  for(const branch of ['sport','club']){
    const r = await runQuery(buildQuery(cc, branch));
    if(!r.elements) return {elements: null, error: `${branch} query: ${r.error}`};
    endpoint = r.endpoint;
    for(const el of r.elements) seen.set(el.type+'/'+el.id, el);
    await sleep(1500);
  }
  return {elements: Array.from(seen.values()), endpoint};
}

/* ------------------------------------------------------------------ *
 * Element -> record
 * ------------------------------------------------------------------ */
function pick(tags, keys){
  for(const k of keys){ if(tags[k] && String(tags[k]).trim()) return String(tags[k]).trim(); }
  return '';
}

function normaliseSite(u){
  if(!u) return '';
  let s = u.trim().split(/[\s,;]+/)[0];
  if(/^www\./i.test(s)) s = 'http://' + s;
  if(!/^https?:\/\//i.test(s)) return '';
  try{
    const url = new URL(s);
    if(!url.hostname.includes('.')) return '';
    // a facebook page is not a website we can crawl for a club address
    if(/facebook|instagram|twitter|x\.com|linktr\.ee|tiktok|youtube/i.test(url.hostname)) return '';
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  }catch(e){ return ''; }
}

function toRecord(el, cc){
  const t = el.tags || {};
  const name = pick(t, ['name','official_name','alt_name']);
  if(!name) return null;

  let sports = sportsFromTag(t.sport);
  if(!sports.length) sports = detectSports(name + ' ' + (t.club||''));
  if(!sports.length) return null;

  const website = normaliseSite(pick(t, ['contact:website','website','url','contact:url']));
  const email   = (pick(t, ['contact:email','email','contact:mail']).split(/[\s,;]+/)[0] || '').toLowerCase();

  const verdict = privateClub({
    name,
    website,
    email,
    operator: t.operator || '',
    description: [t.description||'', t.club||'', t.leisure||'', t.access||'', t.operator_type||''].join(' ')
  });
  if(!verdict.ok) return {reject: verdict.reason};

  // access=yes on a sports centre means anyone can walk in — that is a public
  // facility, not a private club
  if(/^(yes|public|permissive)$/i.test(t.access||'')) return {reject:'access='+t.access};
  if(/^(government|public|council)$/i.test(t.operator_type||'')) return {reject:'operator_type='+t.operator_type};

  const rec = {
    name, cc, country: nameOf(cc), lang: langOf(cc), sports,
    website, email,
    contact: pick(t, ['contact:person','contact:name']),
    src: 'osm',
    srcPage: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    crawled: !!email,
    attempts: 0
  };

  // A real club with no website and no email tagged. Nothing to crawl yet, so
  // it does not belong in the database — a record with no email is not a
  // result. It is kept as a lead: the name and the town are enough to find
  // the club's site later, and throwing it away would mean rediscovering it
  // on every run.
  if(!website && !email){
    rec.lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    rec.lon = el.lon != null ? el.lon : (el.center && el.center.lon);
    rec.town = pick(t, ['addr:city','addr:town','addr:suburb','addr:village']);
    return {lead: rec};
  }

  return rec;
}

/* ------------------------------------------------------------------ *
 * Store — same key rule as the daemon so the two merge cleanly
 * ------------------------------------------------------------------ */
function keyFor(rec){
  if(rec.website){
    try{ return 'w:'+new URL(rec.website).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){}
  }
  if(rec.email) return 'e:'+rec.email;
  return 'n:'+rec.cc+':'+String(rec.name).toLowerCase().replace(/[^a-z0-9]+/g,'');
}

function readJSON(f, fallback){
  if(!fs.existsSync(f)) return fallback;
  try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return fallback; }
}
function writeJSON(f, o){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(f, JSON.stringify(o, null, 1));
}

/**
 * Import one country. Returns a summary; the caller writes the db.
 * `db` is mutated in place so the daemon can fold this into its own tick.
 */
async function importCountry(cc, db, log){
  cc = String(cc).toUpperCase();
  const say = log || (()=>{});
  if(!isWanted(cc)) return {cc, error:'not in the country list'};

  const {elements, error, endpoint} = await overpass(cc);
  if(!elements) return {cc, error: error || 'no response'};

  const leads = readJSON(LEADS_FILE, {});
  let added=0, merged=0, rejected=0, withEmail=0, leadCount=0;

  for(const el of elements){
    const out = toRecord(el, cc);
    if(!out) continue;
    if(out.reject){ rejected++; continue; }
    if(out.lead){
      const lk = 'n:'+cc+':'+out.lead.name.toLowerCase().replace(/[^a-z0-9]+/g,'');
      if(!leads[lk]){ leads[lk] = out.lead; leadCount++; }
      continue;
    }
    const rec = out;

    const k = keyFor(rec);
    if(db[k]){
      const cur = db[k];
      if(!cur.email && rec.email){ cur.email = rec.email; cur.crawled = true; withEmail++; }
      if(!cur.website && rec.website) cur.website = rec.website;
      if(!cur.contact && rec.contact) cur.contact = rec.contact;
      cur.sports = Array.from(new Set((cur.sports||[]).concat(rec.sports)));
      merged++;
    } else {
      db[k] = rec;
      added++;
      if(rec.email) withEmail++;
    }
  }

  if(leadCount) writeJSON(LEADS_FILE, leads);

  say(`osm ${cc} ${nameOf(cc)}: ${elements.length} places -> +${added} new, ${merged} merged, ` +
      `${withEmail} with an email already, ${leadCount} leads with no contact tag, ` +
      `${rejected} dropped as public`);

  return {cc, seen: elements.length, added, merged, rejected, withEmail, leads: leadCount, endpoint};
}

/* Which country to do next: the one never imported, in priority order, then
 * the one imported longest ago. State is on disk, so a run picks up where the
 * last one stopped rather than starting at Spain every time. */
function nextCountry(){
  const state = readJSON(STATE_FILE, {});
  const fresh = PRIORITY.find(cc => !state[cc]);
  if(fresh) return fresh;
  const done = PRIORITY.slice().sort((a,b)=>
    String(state[a] && state[a].at || '').localeCompare(String(state[b] && state[b].at || '')));
  return done[0];
}

function markDone(cc, summary){
  const state = readJSON(STATE_FILE, {});
  state[cc] = Object.assign({at: new Date().toISOString()}, summary);
  writeJSON(STATE_FILE, state);
}

function status(){
  const state = readJSON(STATE_FILE, {});
  const done = Object.keys(state);
  console.log(`\nOSM import — ${done.length} of ${PRIORITY.length} countries done\n`);
  if(!done.length){ console.log('  nothing yet:  node lib/osm.js --all\n'); return; }
  console.log('cc  country                     places   kept  leads  public   when        via');
  console.log('-'.repeat(88));
  for(const cc of PRIORITY){
    const s = state[cc];
    if(!s) continue;
    console.log(
      cc.padEnd(4) + nameOf(cc).padEnd(26) +
      String(s.seen==null?'-':s.seen).padStart(6) +
      String(s.added==null?'-':s.added).padStart(7) +
      String(s.leads==null?'-':s.leads).padStart(7) +
      String(s.rejected==null?'-':s.rejected).padStart(8) +
      '   ' + String(s.at||'').slice(0,10) +
      '  ' + String(s.via||'') +
      (s.error ? '  ERROR: '+s.error : '')
    );
  }
  const pending = PRIORITY.filter(cc=>!state[cc]);
  if(pending.length) console.log(`\nnot yet imported (${pending.length}): ${pending.join(' ')}`);
  console.log('');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
async function main(){
  const args = process.argv.slice(2);
  if(!args.length || args[0] === '--help'){
    console.log(`
OpenStreetMap club importer — no key, no account, no quota

  node lib/osm.js ES              one country
  node lib/osm.js ES PT BR        several
  node lib/osm.js --all           every country in the brief, priority order
  node lib/osm.js --status        what has been imported so far

Keeps only places that publish a website or an email; anything else has no
route to a contact. Public and council-run facilities are dropped on the way
in. Everything lands in data/clubs.json, where the daemon's crawler picks up
the ones still missing an email.
`);
    return;
  }
  if(args[0] === '--status') return status();

  const list = args[0] === '--all' ? PRIORITY : args.map(a=>a.toUpperCase()).filter(isWanted);
  if(!list.length){ console.error('No valid country codes given.'); process.exitCode = 1; return; }

  const db = readJSON(DB_FILE, {});
  let total = 0;

  for(let i=0;i<list.length;i++){
    const cc = list[i];
    process.stdout.write(`[${i+1}/${list.length}] ${cc} ${nameOf(cc)} ... `);
    const s = await importCountry(cc, db, m=>console.log('\r'+m));
    if(s.error){
      console.log(`failed: ${s.error}`);
      markDone(cc, {error: s.error});
    } else {
      total += s.added;
      // The mirror is recorded because they carry different snapshots: a
      // country served by a lagging mirror comes back short, and re-running
      // it later against a fresher one tops it up.
      markDone(cc, {seen:s.seen, added:s.added, merged:s.merged, rejected:s.rejected,
                    leads:s.leads, via:(s.endpoint||'').replace(/^https?:\/\//,'').split('/')[0]});
    }
    writeJSON(DB_FILE, db);            // save after each country, never lose a run
    if(i < list.length-1) await sleep(PAUSE_MS);
  }

  const withEmail = Object.values(db).filter(r=>r.email).length;
  const queued    = Object.values(db).filter(r=>!r.email && r.website).length;
  console.log(`\n+${total} new clubs. Database now holds ${Object.keys(db).length} records: ` +
              `${withEmail} with an email, ${queued} with a site still to crawl.`);
  console.log(`Next:  node daemon.js once     (crawls those sites for addresses)`);
}

if(require.main === module) main();

module.exports = { importCountry, nextCountry, markDone, buildQuery, toRecord, keyFor };
