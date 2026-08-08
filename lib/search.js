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

const ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';

/* One query at a time with a real gap between them. This is somebody's free
 * service and a club list is not worth being rude over. */
const GAP_MS = 2500;
let lastQuery = 0;

/* Results that are never a club's own website */
const NOT_A_CLUB_SITE = new RegExp([
  'facebook','instagram','twitter','x\\.com','youtube','linkedin','tiktok','pinterest',
  'tripadvisor','yelp','foursquare','yellowpages','paginasamarillas','paginas-amarelas',
  'google\\.','maps\\.','goo\\.gl','wa\\.me','t\\.me','wikipedia','wikimapia',
  'openstreetmap','booking\\.com','airbnb','indeed','glassdoor','crunchbase',
  'cylex','tuugo','opendi','hotfrog','local\\.ch','infobel','kompass',
  'playtomic','matchi','ubitennis','sportplus','clubspark','courtreserve',
  'eventbrite','meetup','amazon','ebay','\\.pdf$'
].join('|'), 'i');

/**
 * Run one search and return the result URLs in order.
 *
 * DuckDuckGo's lite page wraps every outbound link as /l/?uddg=<encoded>,
 * which is convenient: it means the real destinations can be read out
 * without parsing the surrounding markup at all.
 */
async function searchWeb(query, timeoutMs){
  const wait = GAP_MS - (Date.now() - lastQuery);
  if(wait > 0) await sleep(wait);
  lastQuery = Date.now();

  const html = await rawFetch(ENDPOINT + encodeURIComponent(query), timeoutMs || 8000);
  if(!html) return [];

  const out = [];
  for(const m of html.matchAll(/uddg=([^&"'\s]+)/g)){
    let u;
    try{ u = decodeURIComponent(m[1]); }catch(e){ continue; }
    if(!/^https?:\/\//i.test(u)) continue;
    u = u.split('#')[0];
    if(!out.includes(u)) out.push(u);
  }
  return out;
}

/* Strip the URL down to its origin: the search result may be a deep page,
 * but the crawler wants the site. */
function originOf(u){
  try{ const x = new URL(u); return x.origin; }catch(e){ return ''; }
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

  const queries = [
    [name, town, country].filter(Boolean).join(' '),
    [name, country].filter(Boolean).join(' ')
  ].filter((q,i,a) => a.indexOf(q) === i);

  const tried = [];
  for(const q of queries){
    const results = await searchWeb(q, timeoutMs);
    tried.push({query: q, results: results.length});
    if(!results.length) continue;

    for(const r of results.slice(0, 8)){
      if(NOT_A_CLUB_SITE.test(r)) continue;
      const origin = originOf(r);
      if(!origin) continue;
      // The name has to be in the domain. Without this the first directory
      // listing or news article becomes the club's "website".
      if(!plausibleSite(name, origin)) continue;
      return {url: origin, queries: tried, note: 'matched ' + origin};
    }
  }
  return {url:'', queries: tried, note: 'no result whose domain matches the name'};
}

module.exports = { searchWeb, findClubSite, ENDPOINT, NOT_A_CLUB_SITE };
