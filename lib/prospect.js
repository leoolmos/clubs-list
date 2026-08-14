'use strict';
/**
 * prospect.js — find clubs in the countries nobody has listed
 * =========================================================================
 * Sixty-two of the eighty-three countries hold nothing at all, and it is not
 * because the collector failed in them. It is because neither engine that
 * finds clubs was ever pointed at them:
 *
 *   - Every one of the 64 directory seeds is Spain, Ireland or Britain. The
 *     directory walk is the best engine there is — 52 Spanish seeds produced
 *     540 clubs, over half the database — and eighty countries have never
 *     had a single page of it.
 *
 *   - The search engine only ever looks up a name OpenStreetMap already
 *     gave it. In these countries OSM gives almost nothing: Kenya returned
 *     18 places and 13 were dropped as public, Malawi returned 4. No name
 *     means no query, so nothing is ever searched, and the country stays at
 *     zero however long the collector runs.
 *
 * This is the missing engine: it searches for the clubs of a country
 * directly, in that country's language, with no name to start from.
 *
 * The bar has to be higher here than for a lead. Looking up "Buckley Park
 * Tennis Club" and checking the answer against its name is a strong test;
 * asking for "tennis club Zambia" and trusting the first result is not one
 * at all. So a candidate is read before it is believed: it has to look like
 * a racket club on its own page, pass the same private-club rules as every
 * other record, and belong to the country that was asked about.
 *
 * What it does not do is find the email — it only has to establish that a
 * club exists and where its site is. The crawl phase already turns a website
 * into an address, and it does it better than a one-off fetch would.
 * =========================================================================
 */

const { getPage, isChallenge } = require('./http');
const { searchWeb, NOT_A_CLUB_SITE } = require('./search');
const { detectSports, privateClub, RE_PUBLIC_DOMAIN, RE_CLUBWORD } = require('./classify');
const { COUNTRIES, nameOf, langOf, ccFromHost, isWanted } = require('./countries');

/* The sport in the language the clubs write it in. A Spanish query against
 * Panama finds "Club de Tenis" pages that an English one does not rank. */
const TERMS = {
  Spanish:    ['club de tenis', 'club de p\u00e1del', 'club de squash', 'academia de tenis', 'centro de padel'],
  Portuguese: ['clube de t\u00e9nis', 'clube de padel', 'clube de squash', 'academia de t\u00eanis', 'centro de padel'],
  English:    ['tennis club', 'padel club', 'squash club', 'racquet club', 'tennis centre', 'padel center']
};

/* Asking for the contact page as well as the club pushes the pages that
 * publish an address up the results, which is the half worth having. */
const CONTACT_WORD = {
  Spanish: 'contacto', Portuguese: 'contacto', English: 'contact'
};

/* City-level queries for the countries big enough that one country-wide
 * query only ever surfaces the same ten famous clubs. "tennis club Houston"
 * reaches a hundred clubs that "tennis club United States" never ranks.
 * Only cities distinctive enough to tie a page to the country belong here \u2014
 * the vet accepts the city's name on the page as proof of place. */
/* Every city of 20,000 people or more, per country, biggest first — built
   from GeoNames (CC-BY) by scripts/build-cities.js. 13,753 of them: the
   prospector asks every term against every one, so "clube de tênis Santos
   contato" happens as surely as "tennis club London contact". Names shared
   across countries exist (Córdoba, Valencia); the vet's place checks and
   the language of the query keep most strays out, and a name under five
   characters is never accepted as proof of place on its own. */
const CITIES = require('./cities.json');

/* Everything the search returns that is a listing of clubs rather than a
 * club. Worth keeping separate from NOT_A_CLUB_SITE: those are junk, these
 * are often good directories, and a later pass could seed them.
 */
const RE_AGGREGATOR = new RegExp([
  'wikipedia','wikidata','tripadvisor','yelp','expedia','hotels?\\.com',
  'playtomic','matchi','padelmates','\\bitf','\\bwta','\\batptour',
  'sportsvenue','venue-?finder','directory','yellowpages','businesslist',
  'facebook','instagram','youtube','linkedin','\\.gov','\\.gob\\.','\\bun\\.org'
].join('|'), 'i');

/* A title that is a sentence is a listing page describing its contents, not
 * a club naming itself: "Encuentra canchas y clubes de pádel en Uruguay"
 * carries the word clubes and is a directory of them. */
const RE_LISTING_NAME = new RegExp([
  'encuentra','busca(r|dor)?','directorio','listado','gu[ií]a','mejores','los \\d',
  'find (a|the|your)','search for','best \\d?','top \\d','listings?','booking system',
  'reserva (tu|de)','book (a|your)','compare','marketplace','platform','software',
  // A club is somewhere. Anything advertising its reach across the world is
  // an index of clubs: "Pistas de padel en todo el mundo" was filed as a
  // club in El Salvador because it happened to rank for one.
  'en todo el mundo','por el mundo','no mundo','worldwide','around the world',
  'all over the world','del mundo','globally'
].join('|'), 'i');

/* Titles arrive as "Nairobi Tennis Club | Home" or "Welcome to the Lusaka
 * Squash Club - Est. 1954". The club is the first piece, minus the throat
 * clearing at either end. */
function nameFromTitle(title){
  // The comma is in here because a club that adds its own tagline uses one:
  // "lapala club, p\u00e1del en Quito" would otherwise be published under the
  // whole sentence as its name.
  let t = String(title||'').split(/[|\u2013\u2014\u00b7\u2022,]|\s+-\s+/)[0].trim();
  t = t.replace(/^(welcome to|bienvenidos? a|bem-vindos? a|home\s*[-:]\s*)/i, '').trim();
  t = t.replace(/\s*[-:,]\s*(home|inicio|in[ií]cio|official site|sitio oficial)\s*$/i, '').trim();
  return t.replace(/\s+/g, ' ').slice(0, 90);
}

/* The <title> is the club's own name for itself and the best one available;
 * an <h1> is the fallback for the sites that title themselves "Home". */
function titleOf(html){
  const t = (String(html).match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '';
  if(t.trim()) return decodeEntities(t);
  const h = (String(html).match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i) || [])[1] || '';
  return decodeEntities(h.replace(/<[^>]+>/g, ' '));
}

function decodeEntities(s){
  return String(s).replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ')
                  .replace(/&#(\d+);/g, (_,d)=>String.fromCharCode(+d))
                  .replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
}

function textOf(html){
  return String(html).replace(/<script[\s\S]*?<\/script>/gi,' ')
                     .replace(/<style[\s\S]*?<\/style>/gi,' ')
                     .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
}

/**
 * Read a candidate and decide whether it is a club in this country.
 *
 * Returns a record with no email — the crawl phase fills that in — or a
 * reason it was turned down, which is logged so a bad rule can be found
 * later rather than quietly costing a country its clubs.
 */
async function vet(url, cc, timeoutMs, city){
  let origin, host;
  try{ const u = new URL(url); origin = u.origin; host = u.hostname; }
  catch(e){ return {reason:'bad url'}; }

  // A result on another wanted country's domain belongs to that country, not
  // this one. .com says nothing either way, so it is allowed through to the
  // page test rather than guessed at.
  const hostCc = ccFromHost(host);
  if(hostCc && isWanted(hostCc) && hostCc !== cc) return {reason:'domain belongs to '+hostCc};

  const html = await getPage(origin, undefined, timeoutMs);
  if(!html) return {reason:'unreachable'};
  if(isChallenge(html)) return {reason:'blocked by a challenge page'};

  const title = titleOf(html);
  const name  = nameFromTitle(title);
  if(!name) return {reason:'no name on the page'};

  const text   = textOf(html);
  const sports = detectSports(title + ' ' + name + ' ' + text);
  if(!sports.length) return {reason:'no racket sport on the page'};

  if(RE_LISTING_NAME.test(name)) return {reason:'a listing of clubs, not one: "'+name+'"'};

  // A site titled with its own domain has not named a club. "squash.today"
  // is a squash magazine, and it was about to be published as the sole club
  // of Equatorial Guinea.
  if(/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name)) return {reason:'the title is a domain, not a club: "'+name+'"'};

  // A club naming itself does it in a few words. Anything longer is a slogan
  // or a description, and the name would be published as the club's own.
  if(name.split(/\s+/).length > 8) return {reason:'title is a description, not a name'};

  // The club word has to be in the name, not merely somewhere in the page —
  // a hotel that mentions its tennis court would pass on the text alone.
  if(!RE_CLUBWORD.test(name)) return {reason:'no club signal in "'+name+'"'};

  // Naming a different one of the eighty-three is disqualifying however much
  // it mentions this one: "Court Booking System for South Africa" was ranked
  // for Kenya and would have been published as a Kenyan club.
  for(const [other, [otherName]] of Object.entries(COUNTRIES)){
    if(other === cc) continue;
    if(new RegExp('\\b'+otherName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(name)){
      return {reason:'names '+otherName+', not '+nameOf(cc)};
    }
  }

  const rec = {name, website: origin, sports};
  const verdict = privateClub(rec);
  if(!verdict.ok) return {reason: verdict.reason};

  // The country was asked for in the query, but the engine answers loosely.
  // A country-coded domain has already proved itself above; anything else
  // has to say the country's name on its own pages.
  const country = nameOf(cc);
  const RE_COUNTRY = new RegExp('\\b'+country.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i');
  // A query asked for one city, so that city's name on the page is as good
  // a tie as the country's — a club in Houston prints Houston, not
  // "United States". Domains on another wanted country were rejected above.
  // Short names prove nothing, though: "York" matches every page about New
  // York, "Bath" every page with a changing room. Five characters or more.
  const RE_CITY = (city && String(city).length >= 5)
    ? new RegExp('\\b'+String(city).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i') : null;
  let tied = hostCc === cc || RE_COUNTRY.test(text) || (RE_CITY && RE_CITY.test(text));

  // A club whose members all live in the same city has no reason to print
  // the country on its front page — it is the address on the contact page
  // that names it. Karura Tennis Club, in Nairobi since 1978, was turned
  // down as "nothing ties it to Kenya" on a .com domain. Two more fetches,
  // and only for the candidates actually in doubt.
  if(!tied){
    for(const p of ['/contact', '/contacto']){
      const page = await getPage(origin + p, undefined, timeoutMs);
      if(!page) continue;
      const ptext = textOf(page);
      if(RE_COUNTRY.test(ptext) || (RE_CITY && RE_CITY.test(ptext))){ tied = true; break; }
    }
  }
  if(!tied) return {reason:'nothing on its pages ties it to '+(city || country)};

  return {
    rec: {
      name, cc, country, lang: langOf(cc), sports,
      website: origin, email: '',
      contact: '', src: 'prospect', srcPage: url,
      crawled: false, attempts: 0
    }
  };
}

/**
 * Search out the clubs of one country.
 *
 * The queries are cheap and the vetting is not, so the search runs first and
 * the candidates are filtered hard before a single page is opened.
 */
async function prospectCountry(cc, opts){
  opts = opts || {};
  const say      = opts.log || (()=>{});
  const known    = opts.knownHosts || new Set();
  const done     = new Set(opts.queriesDone || []);
  const deadline = opts.deadline || (Date.now() + 120000);
  const country  = nameOf(cc);
  const lang     = langOf(cc);
  const terms    = TERMS[lang] || TERMS.English;
  const word     = CONTACT_WORD[lang] || CONTACT_WORD.English;

  // The country-wide queries first, then one set per city, biggest city
  // first. The city is carried along so the vet can accept it as proof of
  // place. maxQueries caps one call: Brazil holds 1,808 cities, and without
  // a cap it would monopolise the phase for days while ninety countries
  // waited.
  const cities = CITIES[cc] || [];
  const maxQ = opts.maxQueries || 40;
  const queries = terms.map(t => ({q: `${t} ${country} ${word}`}))
    .concat(cities.flatMap(city => terms.map(t => ({q: `${t} ${city} ${word}`, city}))));
  const out = {cc, country, queries:0, results:0, candidates:0, added:[], rejected:[], throttled:false,
               perCity:{}, citiesTotal: cities.length};

  const seen = new Set();
  for(const {q, city} of queries){
    if(Date.now() > deadline) break;
    if(out.queries >= maxQ) break;
    if(done.has(q)) continue;
    const cityKey = city || '';
    const pc = out.perCity[cityKey] || (out.perCity[cityKey] = {s:0, f:0});
    pc.s++;

    const results = await searchWeb(q, opts.timeoutMs || 9000);
    out.queries++;
    done.add(q);
    out.lastQuery = q;

    // Nothing at all, from a query that has not been asked before, is the
    // engine turning us away rather than a country with no clubs.
    if(!results.length){ out.throttled = true; break; }
    out.results += results.length;

    for(const r of results){
      if(Date.now() > deadline) break;
      let host;
      try{ host = new URL(r.url).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){ continue; }
      if(seen.has(host) || known.has(host)) continue;
      seen.add(host);
      if(NOT_A_CLUB_SITE.test(r.url) || RE_AGGREGATOR.test(r.url)) continue;
      if(RE_PUBLIC_DOMAIN.test(r.url)) continue;

      out.candidates++;
      const v = await vet(r.url, cc, opts.timeoutMs, city);
      if(v.rec){
        out.added.push(v.rec);
        pc.f++;
        say(`prospect ${cc}${city ? ' · '+city : ''}: ${v.rec.name} -> ${v.rec.website}`);
      } else {
        out.rejected.push({url:r.url, reason:v.reason});
      }
    }
  }

  out.queriesDone = Array.from(done);
  return out;
}

module.exports = { prospectCountry, vet, nameFromTitle, TERMS, CITIES };
