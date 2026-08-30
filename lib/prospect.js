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
const { COUNTRIES, nameOf, langOf, localNameOf, placeNames, ccFromHost, isWanted } = require('./countries');
const { cityIn } = require('./place');

/* The sport in the language the clubs write it in. A Spanish query against
 * Panama finds "Club de Tenis" pages that an English one does not rank.
 *
 * Three terms a city, not six. 13,753 cities at six terms was 82,000
 * queries, which at a polite pace is the better part of a week before the
 * last city is asked once \u2014 and "academia de tenis Santos" returned mostly
 * the same sites as "clube de t\u00eanis Santos". One term a sport, with the
 * country's name now in the query to sharpen it, covers the city in half
 * the requests. Racquet club stays for the English-speaking countries
 * because it is how half the American ones are named. */
const TERMS = {
  Spanish:    ['club de tenis', 'club de p\u00e1del', 'club de squash'],
  Portuguese: ['clube de t\u00e9nis', 'clube de padel', 'clube de squash'],
  English:    ['tennis club', 'padel club', 'squash club', 'racquet club']
};

/* Candidates from one query are read a few at a time. The engine is asked
 * one query at a time with a gap, but the thirty sites it returns are
 * thirty different hosts, and reading them one after another made the
 * search phase wait on slow club sites instead of on the engine. */
const VET_PARALLEL = parseInt(process.env.VET_PARALLEL || '4', 10);

async function pool(items, limit, fn){
  const q = items.slice();
  await Promise.all(Array.from({length: Math.min(limit, q.length)}, async () => {
    while(q.length){
      const it = q.shift();
      try{ await fn(it); }catch(e){}
    }
  }));
}

/* Asking for the contact page as well as the club pushes the pages that
 * publish an address up the results, which is the half worth having. The
 * word itself — contacto, contactos, contato, contact — and the spelling it
 * alternates with live in lib/contact.js, beside the paths the crawl tries. */
const { searchWord, placePaths } = require('./contact');

/* Brazil writes tênis with a circumflex and contato without the c, and the
 * European spellings rank a different set of pages: "clube de tênis Santos
 * contato" surfaced a Santos club that "clube de ténis Santos contacto" did
 * not. Only Brazil differs — Portugal, Angola and Mozambique keep the first
 * set — so this is a country override rather than a change of language. */
const TERMS_BY_CC = {
  BR: ['clube de tênis', 'clube de padel', 'clube de squash']
};

/* The terms one country is searched with. daemon.js counts the planned
 * searches from the same function, so the two cannot drift apart. */
function termsFor(cc, lang){
  return TERMS_BY_CC[cc] || TERMS[lang || langOf(cc)] || TERMS.English;
}

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

/* Words that carry no identity: the sports, the club words, the country's
 * names, and the vocabulary of listings and governing bodies. A name with
 * nothing left after these is generic. */
const GENERIC_WORDS = new Set([
  'club','clubs','clube','clubes','de','del','la','el','los','las','do','da','dos','das','of','the','and','y','e','en','em','in',
  'tenis','tennis','padel','squash','racquet','racket','lawn','sport','sports','deporte','deportes','esporte','esportes',
  'centro','centre','center','centros','academia','academy','escuela','escola','school',
  'world','mundial','tour','info','online','oficial','official','web','site','portal','guia','guide','directorio','directory',
  'federacion','federation','federacao','asociacion','association','associacao','liga','league','ranking','circuito','circuit',
  'torneo','torneos','torneio','tournament','pro','top','best','mejores',
  'pistas','canchas','quadras','courts','court','cancha','pista','quadra','reservas','booking','reserva'
]);
function genericName(name, cc){
  const countryWords = new Set(placeNames(cc).flatMap(n => n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').split(/[^a-z0-9]+/)).filter(Boolean));
  const toks = String(name||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').split(/[^a-z0-9]+/).filter(Boolean);
  if(!toks.length) return true;
  return toks.every(t => GENERIC_WORDS.has(t) || countryWords.has(t) || t.length <= 2);
}

/* Titles arrive as "Nairobi Tennis Club | Home" or "Welcome to the Lusaka
 * Squash Club - Est. 1954". The club is the first piece, minus the throat
 * clearing at either end. */
function nameFromTitle(title){
  // The comma is in here because a club that adds its own tagline uses one:
  // "lapala club, p\u00e1del en Quito" would otherwise be published under the
  // whole sentence as its name.
  //
  // Which side of the separator the club sits on varies, and taking the
  // first segment cost real clubs. Tênis Clube de Santos titles its homepage
  // "Home - Tênis Clube de Santos": the name was read as "Home", failed the
  // club-word test, and a club that ranks first for a search of its own city
  // was discarded every single time it was found. Every segment is a
  // candidate now and the one that names a club wins. The first is still the
  // answer when none of them does, so every other page reads as it did.
  const parts = String(title||'').split(/[|\u2013\u2014\u00b7\u2022,]|\s+-\s+/)
    .map(seg => {
      let t = String(seg).trim();
      t = t.replace(/^(welcome to|bienvenidos? a|bem-vindos? a|home\s*[-:]\s*)/i, '').trim();
      t = t.replace(/\s*[-:,]\s*(home|inicio|in[ií]cio|official site|sitio oficial)\s*$/i, '').trim();
      return t.replace(/\s+/g, ' ').slice(0, 90);
    })
    .filter(Boolean);
  if(!parts.length) return '';
  return parts.find(t => RE_CLUBWORD.test(t)) || parts[0];
}

/* Every place a page names itself, best first. The <title> is the club's own
 * name for itself and stays first, but a site that titles itself plainly
 * "Home" keeps the real name in og:site_name often enough to be worth
 * reading. Each candidate faces the same tests the title always faced;
 * nothing is accepted merely for being present. */
function nameCandidates(html){
  const h = String(html);
  const out = [];
  const t = (h.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1];
  if(t) out.push(decodeEntities(t));
  const re = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:site_name|og:title|application-name)["'][^>]*>/gi;
  let m;
  while((m = re.exec(h))){
    const c = (m[0].match(/content\s*=\s*["']([^"']{1,200})["']/i) || [])[1];
    if(c) out.push(decodeEntities(c));
  }
  const h1 = (h.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i) || [])[1];
  if(h1) out.push(decodeEntities(h1.replace(/<[^>]+>/g, ' ')));
  return out;
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
  const named = nameCandidates(html).map(nameFromTitle).filter(Boolean);
  // The first candidate that names a club with a word of its own; a site
  // titled plainly "Tennis Club" usually keeps its real name in og:site_name
  // or the h1, and that one is taken before the title.
  const name  = named.find(n => RE_CLUBWORD.test(n) && !genericName(n, cc))
             || named.find(n => RE_CLUBWORD.test(n)) || nameFromTitle(title);
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

  // A name made only of the sport, the word club and the country is not a
  // club's name, it is a subject: "Padel España", "Clubs de Pádel España",
  // "Pádel en España" and "World Padel Tour" were all filed as Spanish
  // clubs, and each is an index of them. A club names itself with at least
  // one word that is its own.
  if(genericName(name, cc)) return {reason:'a listing of clubs, not one: "'+name+'"'};

  // A federation is a governing body, never a private club. The private-club
  // rules know the word, but a page that declares the wrong character set
  // arrives as "Federaci n Espa ola" and slips past them; one garbled letter
  // is allowed for here.
  if(/\bfederaci.{0,2}n\b|\bfedera.{1,3}o\b|\bfederation\b|\bconfedera/i.test(name)) return {reason:'a governing body, not a club: "'+name+'"'};

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
  // has to say the country's name on its own pages — in any of the forms
  // its own clubs use: Brasil as well as Brazil, UK as well as United
  // Kingdom. Asking only for the English name turned down Brazilian clubs
  // whose every page says Brasil.
  const country = nameOf(cc);
  const RE_COUNTRY = new RegExp('(?:^|[^\\p{L}])(?:' + placeNames(cc).map(n => n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')(?![\\p{L}])','iu');
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
    for(const p of placePaths(langOf(cc), cc)){
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
      // which city's search surfaced it — the coverage tab counts the
      // emails the crawl later finds, city by city. A country-wide search
      // names no city, so the page's own address is read for one.
      city: city || cityIn(cc, text) || '',
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
/* One search charged to a city. The twin city is credited with the search
 * but not with the clubs: a club this query turns up is recorded
 * country-wide, and counting it in both places would report it twice. */
function credit(out, city, also){
  const k = city || '';
  const pc = out.perCity[k] || (out.perCity[k] = {s:0, f:0});
  pc.s++;
  if(also){ const pt = out.perCity[also] || (out.perCity[also] = {s:0, f:0}); pt.s++; }
  return pc;
}

async function prospectCountry(cc, opts){
  opts = opts || {};
  const say      = opts.log || (()=>{});
  const known    = opts.knownHosts || new Set();
  const done     = new Set(opts.queriesDone || []);
  // Queries the engine refused earlier. They go to the back of the queue:
  // asking the very same query first every round is what a blocked client
  // looks like, and it kept one country stuck on one query all night.
  const deferred = new Set(opts.deferred || []);
  const deadline = opts.deadline || (Date.now() + 120000);
  const country  = nameOf(cc);
  const lang     = langOf(cc);
  const terms    = termsFor(cc, lang);
  // Term i carries contact word i: the two spellings take turns across the
  // terms, so every city is asked both ways without doubling the queries.
  const word     = i => searchWord(lang, cc, i);

  // The country-wide queries first, then one set per city, biggest city
  // first. The city is carried along so the vet can accept it as proof of
  // place. maxQueries caps one call: Brazil holds 1,808 cities, and without
  // a cap it would monopolise the phase for days while ninety countries
  // waited.
  const cities = CITIES[cc] || [];
  const maxQ = opts.maxQueries || 40;
  // A city carrying the country's own name asks the very queries the
  // country-wide pass has just asked — `tennis club Singapore contact` is
  // both. The duplicate was skipped, as it should be, but the city was
  // never credited with a search either, so Singapore, Hong Kong, Gibraltar
  // and Ilha de Mocambique sat at nought searches for ever and their four
  // countries stopped one city short of complete. The country-wide pass
  // carries the twin along and credits it, once, when it runs.
  // Country and city in every query, both in the country's own language:
  // "clube de tênis Santos Brasil contato", "club de tenis Córdoba
  // Argentina contacto" — the country keeps Córdoba out of Spain and
  // Santos out of the search for some other Santos, and the local name is
  // the one that ranks the local pages.
  const local = localNameOf(cc);
  const twin = twinCity(cc);
  const queries = terms.map((t, i) => ({q: `${t} ${local} ${word(i)}`, also: twin}))
    .concat(cities.filter(c => c !== twin)
                  .flatMap(city => terms.map((t, i) => ({q: `${t} ${city} ${local} ${word(i)}`, city}))));
  const out = {cc, country, queries:0, results:0, candidates:0, added:[], rejected:[], throttled:false,
               perCity:{}, citiesTotal: cities.length};

  const seen = new Set();
  const pending = queries.filter(x => !done.has(x.q));
  const ordered = pending.filter(x => !deferred.has(x.q)).concat(pending.filter(x => deferred.has(x.q)));
  for(const {q, city, also} of ordered){
    if(Date.now() > deadline) break;
    if(out.queries >= maxQ) break;

    // Which city the engine is being asked about right now, so the page
    // can say so while the round is still running rather than after it.
    if(opts.onQuery) opts.onQuery({cc, country, city: city || null, q});
    const results = await searchWeb(q, opts.timeoutMs || 9000);
    out.queries++;

    // The engine objects to this question rather than to us — it does that
    // on wording, and the canary proved the line is open. Asking it again
    // will not go better, so it is marked done and the next one is asked.
    // The city is credited with it all the same. The query is spent —
    // marked done, never asked again — and a city whose queries are all
    // spent is a city the prospector will never come back to. Not
    // counting them left the biggest cities of a country reading nought
    // searches for ever, and the page pointing at them as the next thing
    // it would do.
    if(results.poisoned){
      deferred.delete(q);
      done.add(q);
      out.poisoned = (out.poisoned || 0) + 1;
      credit(out, city, also);
      continue;
    }

    // The engine turning us away is not this country having no clubs. The
    // query is not marked done and the city is not credited with it; it is
    // asked again later, after the others.
    if(results.throttled){ out.throttled = true; out.throttleWhy = results.why; out.refusedQuery = q; break; }
    deferred.delete(q);
    done.add(q);
    out.lastQuery = q;
    const pc = credit(out, city, also);
    out.results += results.length;

    // The cheap filters first, then the sites that survive them are read a
    // few at a time — thirty results is thirty different hosts.
    const cands = [];
    for(const r of results){
      let host;
      try{ host = new URL(r.url).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){ continue; }
      if(seen.has(host) || known.has(host)) continue;
      seen.add(host);
      if(NOT_A_CLUB_SITE.test(r.url) || RE_AGGREGATOR.test(r.url)) continue;
      if(RE_PUBLIC_DOMAIN.test(r.url)) continue;
      cands.push(r);
    }
    out.candidates += cands.length;

    await pool(cands, VET_PARALLEL, async r => {
      if(Date.now() > deadline) return;
      const v = await vet(r.url, cc, opts.timeoutMs, city);
      if(v.rec){
        out.added.push(v.rec);
        pc.f++;
        say(`prospect ${cc}${city ? ' · '+city : ''}: ${v.rec.name} -> ${v.rec.website}`);
      } else {
        out.rejected.push({url:r.url, reason:v.reason});
      }
    });
  }

  out.queriesDone = Array.from(done);
  if(out.refusedQuery) deferred.add(out.refusedQuery);
  // Only queries this country would still ask. A change of wording leaves
  // the old strings behind, and without this they accumulate for ever.
  const asked = new Set(queries.map(x => x.q));
  out.deferred = Array.from(deferred).filter(q => !done.has(q) && asked.has(q));
  return out;
}

/* The city that shares its country's name, if the country has one. Both the
 * search above and the coverage figures in daemon.js need to agree on it. */
function twinCity(cc){
  const country = nameOf(cc);
  return (CITIES[cc] || []).find(c => c === country) || null;
}

module.exports = { prospectCountry, vet, nameFromTitle, nameCandidates, genericName, twinCity, termsFor, TERMS, CITIES };
