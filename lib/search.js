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

const ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';

/* One query at a time with a real gap between them. This is somebody's free
 * service and a club list is not worth being rude over. */
const GAP_MS = parseInt(process.env.SEARCH_GAP_MS || '1200', 10);
let lastQuery = 0;

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
  /* Empty answers are intermittent, and treating one as "not found" is
   * expensive: the lead is marked searched and never looked at again.
   *
   * Measured: fifteen queries at a 1.2s gap gave thirteen full result sets
   * and two empties. The empties came back in 0.1s and about 14KB, against
   * 0.6s and 23KB for a real one — a different response, not a real "no
   * results". Asked again a moment later, the same query returned ten. */
  let html = null;
  for(let attempt = 0; attempt < 3; attempt++){
    const wait = (attempt ? 1500 : GAP_MS) - (Date.now() - lastQuery);
    if(wait > 0) await sleep(wait);
    lastQuery = Date.now();

    html = await rawFetch(ENDPOINT + encodeURIComponent(query), timeoutMs || 8000);
    if(html && /uddg=/.test(html)) break;
    html = null;
  }
  if(!html) return [];

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

module.exports = { searchWeb, findClubSite, ENDPOINT, NOT_A_CLUB_SITE };
