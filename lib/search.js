'use strict';
/**
 * Finding a club's website when nobody has written it down
 * =========================================================================
 * OpenStreetMap knows about far more clubs than it has contact details for.
 * The importer keeps those as leads — a name, a town, a country, and nothing
 * else — and there were 3,876 of them sitting in data/osm-leads.json while
 * the collector had nothing to do. A club with no website is not a dead end;
 * it is a search away from one.
 *
 * Which search engine, and why this one. Checked robots.txt on six:
 *
 *   html.duckduckgo.com     "User-agent: *  Allow: /"     <- usable
 *   lite.duckduckgo.com     "User-agent: *  Allow: /"     <- usable
 *   www.mojeek.com          Disallow: /search
 *   www.startpage.com       Disallow: /sp/
 *   search.brave.com        Disallow: /search
 *
 * Only DuckDuckGo permits it, and it says so explicitly rather than by
 * omission. The lite endpoint is used because it is the smallest: a query
 * comes back in well under a second and about 20KB, against 33KB for the
 * html one.
 *
 * No key, no account, no cost — the same page a person gets.
 */

const { rawFetch, sleep } = require('./http');
const { plausibleSite, nameTokens } = require('./classify');
const { ccFromHost } = require('./countries');

/* Two endpoints, the same ten results from each (measured 2026-08-23: ten
 * distinct URLs a page on both, nine of them shared), so they are
 * interchangeable — and that is the point: when one turns us away the
 * other is asked, and a query is not written off on one endpoint's bad
 * minute. With a browser user-agent the html one answered 202 and an
 * "anomaly" page; with this honest one it answers, so the user-agent stays.
 *
 * A second page (&s=10&dc=11) exists on both and carries about five new
 * results for one more request. Off by default: the queries are the
 * budget, and a second term against the same city buys more than a second
 * page of the first. SEARCH_PAGES=2 turns it on. */
const ENDPOINTS = [
  'https://html.duckduckgo.com/html/?q=',
  'https://lite.duckduckgo.com/lite/?q='
];
const ENDPOINT = ENDPOINTS[0];
const PAGES = Math.max(1, parseInt(process.env.SEARCH_PAGES || '1', 10));
const UA = require('./http').UA;
let queryNo = 0;

/* One query at a time with a real gap between them, and the gap wanders.
 * This is somebody's free service and a club list is not worth being rude
 * over — and a metronome is also exactly what their anomaly detector looks
 * for: at a fixed 1.2 s the engine stopped answering 93 rounds in a row
 * overnight on 2026-08-22, every round, after a handful of queries. */
const GAP_MS = parseInt(process.env.SEARCH_GAP_MS || '10000', 10);
const GAP_MAX_MS = parseInt(process.env.SEARCH_GAP_MAX_MS || '20000', 10);
let lastQuery = 0;

/* The gap adapts. Every refusal stretches it by half, up to GAP_MAX_MS;
 * every thirty answered queries in a row shrink it a tenth, never below
 * GAP_MS. Nobody publishes the engine's tolerance and it is not constant —
 * sixteen queries one hour, thirty-seven the next — so the pace finds the
 * edge itself instead of guessing at it once. Measured 2026-08-23: at 2.5 s
 * the engine refused after 37 queries, at 4 s after 16, and one a minute
 * sailed through for a quarter of an hour. Ten seconds is the opening bid. */
let gapMs = GAP_MS;
let answeredRun = 0;
function onAnswered(){
  if(++answeredRun >= 30){ answeredRun = 0; gapMs = Math.max(GAP_MS, Math.round(gapMs * 0.9)); }
  if(answeredRun >= 10) refusalsInARow = 0;             // the engine is talking to us again
}
function onRefused(){ answeredRun = 0; gapMs = Math.min(GAP_MAX_MS, Math.round(gapMs * 1.5)); }
function currentGapMs(){ return gapMs; }

/* When the engine turns us away it is not asked again on the spot. Its
 * refusal is a challenge page — "Unfortunately, bots use DuckDuckGo too" —
 * and every request made while it is showing that page counts against us:
 * retrying on the other endpoint a moment later, and again a minute after,
 * is how a morning of refusals was made. So one attempt a query, and after
 * a refusal the engine is left alone: five minutes the first time, twice
 * that for each refusal in a row, up to an hour. Every call inside the
 * cooldown answers "throttled" at once rather than adding to the pile, and
 * the caller keeps its place in the queue. */
const COOLDOWN_MS     = parseInt(process.env.SEARCH_COOLDOWN_MS     || '300000', 10);
const COOLDOWN_MAX_MS = parseInt(process.env.SEARCH_COOLDOWN_MAX_MS || '3600000', 10);
let cooldownUntil = 0;
let refusalsInARow = 0;
let lastRefusal = null;

function throttled(results, why){
  const out = results || [];
  out.throttled = true;
  out.why = why || 'refused';
  return out;
}

/* The engine's answer, with the status: rawFetch hides it, and here the
 * difference between 200 with no results and 202 with a challenge page is
 * the whole question. */
async function fetchSearch(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 9000);
  try{
    const r = await fetch(url, {
      headers: {'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-GB,en;q=0.9,es;q=0.8,pt;q=0.8'},
      redirect: 'follow', signal: ctl.signal
    });
    const text = await r.text();
    return {status: r.status, text};
  }catch(e){ return {status: 0, text: ''}; }
  finally{ clearTimeout(t); }
}

/* Did the engine decline rather than answer? A 202 is the challenge page;
 * so is any body that talks about an anomaly or a bot check. A real "no
 * results" page is a 200 that says so. */
function refused(res){
  if(!res || !res.status) return true;
  if(res.status === 202 || res.status === 429 || res.status === 403) return true;
  if(/uddg=/.test(res.text)) return false;
  if(/anomaly|captcha|bot[- ]check|unusual traffic|blocked|challenge/i.test(res.text)) return true;
  if(/no results|no more results|nenhum resultado|sin resultados/i.test(res.text)) return false;
  // A 200 with neither results nor a reason: count it as a refusal, because
  // treating it as "nothing found" is how 3,685 clubs were written off once.
  return true;
}

/* Results that are never a club's own website */
const NOT_A_CLUB_SITE = new RegExp([
  'facebook','instagram','twitter','x\\.com','youtube','linkedin','tiktok','pinterest',
  'tripadvisor','yelp','foursquare','yellowpages','paginasamarillas','paginas-amarelas',
  'google\\.','maps\\.','goo\\.gl','wa\\.me','t\\.me','wikipedia','wikimapia','apple\\.com',
  'openstreetmap','booking\\.com','airbnb','indeed','glassdoor','crunchbase','wanderboat',
  'cylex','tuugo','opendi','hotfrog','local\\.ch','infobel','kompass','findglocal',
  'eventbrite','meetup','amazon','ebay','\\.pdf$'
].join('|'), 'i');

/**
 * Booking and club-management platforms.
 *
 * These were on the blocklist above, which was a straight mistake: this is
 * where a great many British, Irish and New Zealand clubs actually live.
 * Searching for "The Stevenson Tennis Centre" returns
 * clubspark.kiwi/tennisotago as the first result — the club's real page,
 * with its name in the path and a platform in the hostname.
 *
 * Checking only the hostname is why 3,685 of 3,891 clubs came back as "no
 * result whose domain matches the name". A club's own domain is still
 * preferred; these are taken when there is nothing better.
 */
const CLUB_PLATFORM = /clubspark|lta\.org\.uk|matchi\.se|playtomic|courtreserve|sportlomo|teamer|pitchero|gameday|revolutionise|sportsengine|leaguerepublic|tenup|padelmanager|taykus/i;

/**
 * Run one search and return the result URLs in order.
 *
 * DuckDuckGo's lite page wraps every outbound link as /l/?uddg=<encoded>,
 * which is convenient: it means the real destinations can be read out
 * without parsing the surrounding markup at all.
 */
async function searchWeb(query, timeoutMs){
  /* A refusal is reported as an empty array with `throttled` set, so the
   * caller can tell it from a country with no clubs and keep its place in
   * the queue. A genuine "no results" page comes back as a plain empty
   * array. One attempt a query; the endpoints take turns. */
  if(Date.now() < cooldownUntil) return throttled([], 'cooling down');

  const endpoint = ENDPOINTS[queryNo++ % ENDPOINTS.length];
  const jitter = 0.6 + Math.random() * 0.8;              // 60%–140% of the gap
  const wait = Math.round(gapMs * jitter) - (Date.now() - lastQuery);
  if(wait > 0) await sleep(wait);
  lastQuery = Date.now();
  const tries = 1;

  let html = null;
  const res = await fetchSearch(endpoint + encodeURIComponent(query), timeoutMs || 9000);
  if(res.text && /uddg=/.test(res.text)) html = res.text;
  else if(!refused(res)) return [];                       // a real "no results"

  if(!html){
    refusalsInARow++;
    cooldownUntil = Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_MS * Math.pow(2, refusalsInARow - 1));
    onRefused();
    // What the refusal looked like, once per cooldown, so the log can say
    // whether it was the challenge page, an empty 200, or no answer at all.
    const body = String(res && res.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    lastRefusal = {at: Date.now(), status: res ? res.status : 0, tries, query,
                   excerpt: body.slice(0, 160), inARow: refusalsInARow,
                   cooldownMin: Math.round((cooldownUntil - Date.now()) / 60000)};
    return throttled([], `refused (status ${res ? res.status : 0}` +
                         (lastRefusal.excerpt ? `: "${lastRefusal.excerpt.slice(0, 70)}"` : '') +
                         `), ${refusalsInARow} in a row, resting ${lastRefusal.cooldownMin} min`);
  }

  onAnswered();

  // The second page, when asked for and the first was full
  if(PAGES > 1 && (html.match(/uddg=/g) || []).length >= 10){
    const wait = Math.round(gapMs * (0.6 + Math.random() * 0.8)) - (Date.now() - lastQuery);
    if(wait > 0) await sleep(wait);
    lastQuery = Date.now();
    const more = await fetchSearch(ENDPOINTS[0] + encodeURIComponent(query) + '&s=10&dc=11', timeoutMs || 9000);
    if(more.text && /uddg=/.test(more.text)) html += more.text;
  }

  // Titles as well as links. A person deciding whether a result is the club
  // reads the title, and so should this: "Stevenson Tennis Centre - Tennis
  // Courts in Dunedin" identifies the club even when the hostname does not.
  const out = [];
  const seen = new Set();
  for(const m of html.matchAll(/<a[^>]+href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)){
    let u = '';
    try{ u = decodeURIComponent((m[1].match(/uddg=([^&"]+)/)||[])[1] || ''); }catch(e){ continue; }
    if(!/^https?:\/\//i.test(u)) continue;
    u = u.split('#')[0];
    if(seen.has(u)) continue;
    seen.add(u);
    const title = m[2].replace(/<[^>]+>/g,' ').replace(/&amp;/gi,'&').replace(/&[a-z]+;/gi,' ')
                      .replace(/\s+/g,' ').trim();
    out.push({url: u, title});
  }
  return out;
}

/* Strip the URL down to its origin: the search result may be a deep page,
 * but the crawler wants the site. */
function originOf(u){
  try{ const x = new URL(u); return x.origin; }catch(e){ return ''; }
}

/* How much of the club's name appears in a piece of text. Used against both
 * the result title and the URL. */
function nameOverlap(name, text){
  const toks = nameTokens(name);
  if(!toks.length) return 0;
  const flat = String(text||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
  let hit = 0;
  for(const t of toks) if(flat.includes(t)) hit++;
  return hit / toks.length;
}

/**
 * Find the website of one club.
 *
 * Two queries at most. The first is the specific one — name, town, country —
 * and the second drops the town, because OSM's addr:city is often a suburb
 * that nobody else uses in the club's name.
 *
 * A result only counts if the domain looks like it belongs to this club, the
 * same name-to-domain check that stopped clubs being given their federation's
 * sponsor as a website. A wrong site here would be worse than none: it would
 * produce a confident, wrong email.
 */
async function findClubSite(lead, timeoutMs){
  const name    = String(lead.name || '').trim();
  const town    = String(lead.town || '').trim();
  const country = String(lead.country || '').trim();
  if(!name || nameTokens(name).length === 0) return {url:'', queries:[], note:'name too generic to search'};

  /* The country name is deliberately not in the query.
   *
   * "Rainford Tennis Club United Kingdom" returns nothing at all;
   * "Rainford Tennis Club" returns ten results with the club's own site
   * first. Adding the country was quietly emptying most searches, which is
   * the real reason 3,685 of 3,891 clubs came back unfound.
   *
   * The country is still used — but for ranking, further down, by preferring
   * a result on that country's domain. That keeps the protection against
   * matching a same-named club abroad without paying for it in lost
   * results. */
  const queries = [
    [name, town].filter(Boolean).join(' '),
    name
  ].filter((q,i,a) => q && a.indexOf(q) === i);

  const tried = [];
  let platformPick = '';
  let ownPick = '';          // first own-domain match, whatever the country
  let ownPickInCountry = ''; // ... and one whose ccTLD is the right country
  let answered = 0;          // queries that came back with anything at all

  for(const q of queries){
    const results = await searchWeb(q, timeoutMs);
    tried.push({query: q, results: results.length});
    if(!results.length) continue;
    answered++;

    for(const r of results.slice(0, 10)){
      if(NOT_A_CLUB_SITE.test(r.url)) continue;
      const origin = originOf(r.url);
      if(!origin) continue;

      // Best case: the club's own domain carries its name.
      if(plausibleSite(name, origin)){
        if(!ownPick) ownPick = origin;
        // A club in the right country beats a same-named one abroad. This is
        // what the country is for, now that it is out of the query itself.
        if(!ownPickInCountry && lead.cc && ccFromHost(origin) === lead.cc) ownPickInCountry = origin;
        if(ownPickInCountry) return {url: ownPickInCountry, queries: tried, note: 'own domain ' + ownPickInCountry};
        continue;
      }

      // Next best: a club platform where the name is in the path, which is
      // where a great many British, Irish and New Zealand clubs live —
      // clubspark.kiwi/tennisotago and the like. The whole URL is kept,
      // because the path is the club; the origin alone is the platform's
      // front page.
      if(!platformPick && CLUB_PLATFORM.test(origin)){
        const path = r.url.slice(origin.length);
        // Every word of the name has to be there. Half was not enough:
        // "Mount Schank Tennis Club" matched clubspark.lta.org.uk/
        // MountnessingTennisClub on the strength of "mount" alone, which is
        // a different club on the other side of the world.
        if(nameOverlap(name, path) === 1 || nameOverlap(name, r.title) === 1){
          platformPick = r.url;
        }
      }
    }
  }

  // Nothing in the right country, but the name matched a domain somewhere:
  // take it. A club's own site on a .com is extremely common.
  if(ownPick)      return {url: ownPick,      queries: tried, note: 'own domain ' + ownPick};
  if(platformPick) return {url: platformPick, queries: tried, note: 'club platform page ' + platformPick};

  /* Nothing came back at all, from any query, after three tries each. That
   * is the search engine declining to answer, not the club being absent
   * from the web — and the difference matters enormously. Recording it as
   * "not found" marks the club searched and it is never looked at again.
   *
   * This is what happened to the first full pass: 3,685 of 3,891 clubs were
   * written off, while a query typed by hand a minute later returned the
   * club's own site as the first result. */
  if(!answered) return {url:'', queries: tried, note: 'search engine did not answer', throttled: true};

  return {url:'', queries: tried, note: 'no result matching the name'};
}

/* Is the engine currently refusing us? The caller that sees it can say so in
 * the log instead of reporting a country as empty. */
function searchCoolingDown(){ return Date.now() < cooldownUntil; }
function lastSearchRefusal(){ return lastRefusal; }

module.exports = { searchWeb, findClubSite, searchCoolingDown, lastSearchRefusal, currentGapMs,
                   ENDPOINT, ENDPOINTS, NOT_A_CLUB_SITE };
