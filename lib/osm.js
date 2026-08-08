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
 * Places with a website or an email become records; named clubs with
 * neither are kept as leads in data/osm-leads.json rather than being
 * rediscovered on every run.
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

/* Public Overpass instances. All serve the same database, but they do not
 * behave the same, and the difference decides how much can run at once.
 * Each publishes its limit at /api/status; measured 2026-08-08:
 *
 *   overpass-api.de        "Rate limit: 2"   two queries at a time per IP
 *   overpass.kumi.systems  "Rate limit: 0"   no concurrency limit
 *   overpass.private.coffee "Rate limit: 0"  no concurrency limit
 *
 * So the unlimited mirrors go first and carry the parallel work, and the
 * rate-limited one is kept as a fallback. Its data is the freshest — the
 * three carry different snapshots, and on one Malta test they returned 6, 4
 * and 2 places — so it is worth still using, just not worth queueing on.
 *
 * "No limit" is a limit on paperwork, not on capacity: these run on donated
 * hardware. A handful of queries at a time is neighbourly; dozens are not. */
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

const UA = 'RacketClubResearch/1.0 (club directory research; contact: set-your-email@example.com)';

/* 180 seconds meant a doomed query held a worker for three minutes before
 * admitting it had timed out. When the mirrors are busy — and they are,
 * often — failing fast and moving on collects more than waiting does. */
const QUERY_TIMEOUT_S  = 90;
const HTTP_TIMEOUT_MS  = 120000;
const PAUSE_MS         = 8000;   // between countries

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* How the country is split into queries.
 *
 * Getting this wrong cost the best part of an hour. A single union with a
 * regex on sport — ["sport"~"(^|;)(tennis|padel|squash)(;|$)"] — never
/**
 * One statement per request. This is the whole trick, and it took three
 * wrong turns to find.
 *
 * The cost of a country query is the area lookup, and every statement
 * repeats it. The number of statements decides whether the query finishes,
 * not how much it matches. Measured on Malta, a country with six racket
 * venues in the entire database:
 *
 *   one statement    sport=tennis                 36s, works
 *   five statements  five sports in a union      244s, timed out
 *   six statements   plus club=                  504 from the server
 *   twenty-four      sports x four contact keys  hopeless
 *
 * So each goes in its own request. Four small requests per country beat one
 * large one that never returns, and they spread across the mirrors instead
 * of queueing inside a single query.
 *
 * Contact filtering happens in JavaScript afterwards, where it is free.
 * Putting ["website"] in the query is another statement, which is exactly
 * the expensive thing. Keeping it out also preserves the leads: clubs with
 * a name and no contact tagged, worth recording so they are not
 * rediscovered on every run.
 *
 * padel_tennis and paddle_tennis are dropped. They are rare spellings, and
 * a statement costs the same whether it matches three places or none.
 */
const STATEMENTS = [
  '["sport"="tennis"]["name"]',
  '["sport"="padel"]["name"]',
  '["sport"="squash"]["name"]',
  // club=sport would pull in every judo, football and sailing club in the
  // country; on the Malta test that was most of the response.
  '["club"~"^(tennis|padel|squash|racquet)$"]["name"]'
];

function buildQuery(cc, statement){
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];
area["ISO3166-1"="${cc}"][admin_level=2]->.c;
nwr(area.c)${statement};
out tags center;`;
}

/**
 * Run one query across the mirrors until one answers completely.
 *
 * The important part is `remark`. Overpass signals a timed-out or
 * out-of-memory query by returning HTTP 200 with however many elements it
 * managed plus a remark saying so. Treating that as success is how a country
 * silently ends up with a fraction of its clubs and gets marked done.
 */
async function runQuery(query, epOffset, deadline){
  const body = 'data=' + encodeURIComponent(query);
  let lastErr = '';

  // Countries running side by side each start at a different mirror. All of
  // them starting at overpass-api.de would just queue behind one rate
  // limiter and the parallelism would buy nothing.
  const order = ENDPOINTS.map((_, i) => ENDPOINTS[(i + (epOffset||0)) % ENDPOINTS.length]);

  for(const url of order){
    // 429 means the rate limiter, not a broken mirror. Falling straight
    // through to the next one costs us the primary's fresher data, so wait
    // it out here first.
    for(let attempt=0; attempt<3; attempt++){
      // The deadline has to reach in here, not just guard the start of a
      // country. Three mirrors times three attempts times a two-minute
      // timeout is eighteen minutes, so a country begun one second before
      // the deadline could overrun the whole round on its own — which is
      // exactly what a three-minute OpenStreetMap slice was doing.
      if(deadline && Date.now() > deadline) return {elements: null, error: lastErr || 'out of time'};
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

/* One request, deduplicated by OSM id. Either the country comes back or it
 * does not; there is no half-import to flag any more. */
async function overpass(cc, deadline, epOffset){
  const seen = new Map();
  const failed = [];
  let endpoint = '';

  for(let i=0;i<STATEMENTS.length;i++){
    if(deadline && Date.now() > deadline){ failed.push('out of time'); break; }

    // Each statement starts at a different mirror, so the four requests of
    // one country do not all queue on the same server.
    const r = await runQuery(buildQuery(cc, STATEMENTS[i]), (epOffset||0) + i, deadline);
    if(!r.elements){ failed.push(r.error); continue; }

    endpoint = r.endpoint;
    // Deduplicated because a place tagged both sport=tennis and club=tennis
    // comes back from two of the statements.
    for(const el of r.elements) seen.set(el.type+'/'+el.id, el);
    await sleep(1200);
  }

  // All four failing is a failed country. Some failing still yields real
  // clubs, and since records are only ever added or merged the next pass
  // tops it up — but it must not be reported as a clean run.
  if(failed.length === STATEMENTS.length) return {elements: null, error: failed[0] || 'no response'};
  return {elements: Array.from(seen.values()), endpoint, partial: failed.length ? failed.length : null};
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
async function importCountry(cc, db, log, deadline, opts){
  cc = String(cc).toUpperCase();
  const say = log || (()=>{});
  opts = opts || {};
  if(!isWanted(cc)) return {cc, error:'not in the country list'};

  const {elements, error, endpoint} = await overpass(cc, deadline, opts.epOffset);
  if(!elements) return {cc, error: error || 'no response'};

  // When several countries run at once they share one leads object, written
  // by the caller after all of them finish. Each reading and writing the
  // file itself would mean the last one to save wins and the rest are lost.
  const leads = opts.leads || readJSON(LEADS_FILE, {});
  const ownLeads = !opts.leads;
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

  if(leadCount && ownLeads) writeJSON(LEADS_FILE, leads);

  say(`osm ${cc} ${nameOf(cc)}: ${elements.length} places -> +${added} new, ${merged} merged, ` +
      `${withEmail} with an email already, ${leadCount} leads with no contact tag, ` +
      `${rejected} dropped as public`);

  return {cc, seen: elements.length, added, merged, rejected, withEmail, leads: leadCount, endpoint};
}

/**
 * Import several countries at once.
 *
 * The ceiling here is not the machine, it is Overpass. It is a free service
 * run on donated hardware, it limits by IP, and it answers a request over
 * the limit with 429 or by cutting the query short. Past a handful of
 * countries in flight the extra ones spend their time being refused and
 * retried, and the whole batch finishes later than a smaller one would.
 * Three mirrors, and each country starts at a different one, so `parallel`
 * of about 3 to 6 is the useful range. Higher is not faster.
 *
 * Shared state — the club store, the leads, the per-country record — is
 * collected in memory and written once at the end. Letting each country
 * write the files itself means the last save wins and the rest vanish.
 */
async function importMany(codes, db, log, deadline, parallel){
  const say = log || (()=>{});
  const list = codes.slice();
  const leads = readJSON(LEADS_FILE, {});
  const state = readJSON(STATE_FILE, {});
  const results = [];
  const limit = Math.max(1, Math.min(parallel || 4, list.length));

  // When Overpass is refusing — overloaded mirrors, or us having asked too
  // much of them — every country in the batch fails the same way, slowly.
  // After enough consecutive failures the batch gives up and hands the rest
  // of the round back to the crawler, which is where the emails come from
  // and which does not depend on Overpass at all.
  const GIVE_UP_AFTER = Math.max(3, limit);
  let consecutiveFailures = 0;
  let abandoned = false;

  let next = 0;
  async function worker(slot){
    while(true){
      if(abandoned) return;
      const i = next++;
      if(i >= list.length) return;
      if(deadline && Date.now() > deadline) return;

      const cc = list[i];
      let s;
      try{
        s = await importCountry(cc, db, say, deadline, {leads, epOffset: slot});
      }catch(e){
        s = {cc, error: e.message};
      }

      state[cc] = s.error
        ? {at: new Date().toISOString(), error: s.error}
        : {at: new Date().toISOString(), seen:s.seen, added:s.added, merged:s.merged,
           rejected:s.rejected, leads:s.leads,
           via:(s.endpoint||'').replace(/^https?:\/\//,'').split('/')[0]};

      // Written as each country lands, not once at the end. All the workers
      // share this one object, so writing the whole of it each time loses
      // nothing — and a batch that takes ten minutes is otherwise completely
      // silent until it finishes.
      writeJSON(STATE_FILE, state);

      results.push(s);
      if(s.error){
        say(`osm ${cc}: failed — ${s.error}`);
        if(++consecutiveFailures >= GIVE_UP_AFTER){
          abandoned = true;
          say(`osm: ${consecutiveFailures} countries failed in a row, so Overpass is not answering ` +
              `today. Leaving the rest of the round to the crawler; these countries stay unimported ` +
              `and are picked up next time.`);
          return;
        }
      } else {
        consecutiveFailures = 0;
      }
    }
  }

  await Promise.all(Array.from({length: limit}, (_, slot) => worker(slot)));

  writeJSON(LEADS_FILE, leads);
  writeJSON(STATE_FILE, state);
  return results;
}

/* Which country to do next: the one never imported, in priority order, then
 * the one imported longest ago. State is on disk, so a run picks up where the
 * last one stopped rather than starting at Spain every time. */
function nextCountries(n){
  const state = readJSON(STATE_FILE, {});
  const want = Math.max(1, n || 1);
  const out = [];

  // never imported, in priority order
  for(const cc of PRIORITY){
    if(out.length >= want) break;
    if(!state[cc]) out.push(cc);
  }

  // then the ones whose queries failed or only half-answered. Overpass being
  // busy once should not leave a country short until every other has had a
  // turn.
  if(out.length < want){
    const owed = PRIORITY.filter(cc => state[cc] && state[cc].error)
      .sort((a,b)=>String(state[a].at||'').localeCompare(String(state[b].at||'')));
    for(const cc of owed){
      if(out.length >= want) break;
      if(!out.includes(cc)) out.push(cc);
    }
  }

  // then round again, oldest first, to pick up newly tagged clubs
  if(out.length < want){
    const done = PRIORITY.slice().sort((a,b)=>
      String(state[a] && state[a].at || '').localeCompare(String(state[b] && state[b].at || '')));
    for(const cc of done){
      if(out.length >= want) break;
      if(!out.includes(cc)) out.push(cc);
    }
  }
  return out;
}

function nextCountry(){ return nextCountries(1)[0]; }

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

  const parallel = parseInt((args.find(a=>a.startsWith('--parallel='))||'').split('=')[1] || '4', 10);
  const db = readJSON(DB_FILE, {});
  let done = 0;

  console.log(`\n  ${list.length} countries, ${parallel} at a time\n`);

  // Save the store as countries land, so a run stopped halfway keeps what it
  // already found rather than throwing it away.
  const saver = setInterval(()=>writeJSON(DB_FILE, db), 20000);

  const results = await importMany(list, db, m=>{
    done++;
    console.log(`  [${done}/${list.length}] ${m}`);
  }, null, parallel);

  clearInterval(saver);
  writeJSON(DB_FILE, db);

  const total = results.filter(r=>!r.error).reduce((n,r)=>n+(r.added||0), 0);
  const failed = results.filter(r=>r.error);
  const withEmail = Object.values(db).filter(r=>r.email).length;
  const queued    = Object.values(db).filter(r=>!r.email && r.website).length;

  console.log(`\n+${total} new clubs. Database now holds ${Object.keys(db).length} records: ` +
              `${withEmail} with an email, ${queued} with a site still to crawl.`);
  if(failed.length) console.log(`${failed.length} countries failed and will be retried: ${failed.map(f=>f.cc).join(' ')}`);
  console.log(`Next:  node daemon.js once     (crawls those sites for addresses)`);
}

if(require.main === module) main();

module.exports = { importCountry, importMany, nextCountry, nextCountries, markDone,
                   buildQuery, toRecord, keyFor };
