'use strict';
/**
 * lib/contact.js — where a club keeps its address
 * =========================================================================
 * The crawl reads a club's homepage and then the pages most likely to carry
 * an email, and which pages those are depends on the language the site is
 * written in. A Brazilian club publishes on /contato or /fale-conosco, a
 * Portuguese one on /contactos, a Spanish one on /contacto or /contactanos,
 * an English one on /contact-us — and when none of those exists, the legal
 * page, the privacy policy or the membership page usually prints one anyway.
 *
 * Everything that knows a contact word lives here, so the crawl in
 * daemon.js, the prospector's proof-of-place check and the search queries
 * use one vocabulary instead of each carrying a copy that drifts.
 */

/* Guessed paths, per language, most likely first. The crawl tries the links
 * the homepage itself offers before any of these, so a site whose contact
 * page is /atendimento-ao-socio is still found, through its own menu. */
const CONTACT_PATHS = {
  Portuguese: [
    '/contactos','/contacto','/contato','/contatos','/fale-conosco','/faleconosco',
    '/fale-com-a-gente','/atendimento','/contactos.html','/contacto.html','/contato.html',
    '/contato.php','/quem-somos','/sobre','/sobre-nos','/o-clube','/clube','/socios',
    '/associados','/inscricoes','/secretaria','/onde-estamos','/localizacao',
    '/politica-de-privacidade','/aviso-legal'
  ],
  Spanish: [
    '/contacto','/contactos','/contacta','/contactanos','/contactenos','/contacto.html',
    '/contacto.php','/nosotros','/quienes-somos','/el-club','/club','/socios',
    '/hazte-socio','/asociate','/inscripciones','/secretaria','/donde-estamos',
    '/ubicacion','/como-llegar','/aviso-legal','/politica-de-privacidad'
  ],
  English: [
    '/contact','/contact-us','/contactus','/contact.html','/contact.php','/contact-us.html',
    '/about','/about-us','/the-club','/club','/membership','/join','/join-us','/members',
    '/enquiries','/get-in-touch','/find-us','/location','/where-we-are',
    '/privacy-policy','/privacy','/terms'
  ]
};

/* Brazil writes contato without the c and says "fale conosco" where Portugal
 * says "contactos". Same language, different first guesses. */
const CONTACT_PATHS_BY_CC = {
  BR: [
    '/contato','/contatos','/fale-conosco','/faleconosco','/fale-com-a-gente','/atendimento',
    '/contato.html','/contato.php','/contacto','/contactos','/quem-somos','/sobre',
    '/sobre-nos','/o-clube','/clube','/socios','/associados','/inscricoes','/secretaria',
    '/onde-estamos','/localizacao','/politica-de-privacidade','/aviso-legal'
  ]
};

/* The paths to guess for one club: its own language's list in full, then the
 * first few of each other language. A Spanish club on the Costa del Sol with
 * an English-only site is not rare, and /contact costs one fetch. */
function contactPaths(lang, cc){
  const own = (cc && CONTACT_PATHS_BY_CC[cc]) || CONTACT_PATHS[lang] || CONTACT_PATHS.English;
  const ownLang = CONTACT_PATHS[lang] ? lang : 'English';
  const others = Object.keys(CONTACT_PATHS)
    .filter(l => l !== ownLang)
    .flatMap(l => CONTACT_PATHS[l].slice(0, 4));
  return Array.from(new Set(own.concat(others)));
}

/* The pages the prospector opens when a homepage does not name its country:
 * the address is on the contact page, in the language of the site. Three
 * fetches at most, and only for the candidates actually in doubt. */
function placePaths(lang, cc){
  return contactPaths(lang, cc).slice(0, 3);
}

/* A link on the homepage worth following, in three tiers, because the crawl
 * reads a bounded number of pages and the contact page has to come before
 * the cookie policy:
 *
 *   0  a contact page by name, in any of the three languages
 *   1  about the club, its members, its office, or where it is
 *   2  the legal small print — last resort, and still worth a fetch, since
 *      it prints an address on sites that have no contact page at all
 *  -1  not worth a fetch
 */
const RE_TIER0 = new RegExp([
  'contact','contacto','contactos','contacta','cont[aá]ctanos','contactenos','contato','contatos',
  'fale[-\\s_]?conosco','fale[-\\s_]?com','atendimento','contate','escreva','escr[ií]b[ae]n?os',
  'get[-\\s_]?in[-\\s_]?touch','enquir','kontakt','e-?mail'
].join('|'), 'i');

const RE_TIER1 = new RegExp([
  'about','quienes','qui[eé]nes[-\\s_]?somos','quem[-\\s_]?somos','sobre','nosotros',
  'o[-\\s_]clube','el[-\\s_]club','the[-\\s_]club','\\bclub\\b','\\bclube\\b','hist[oó]ri',
  'socios','s[oó]cios','associad','membership','\\bmembers?\\b','\\bjoin\\b','afilia','asociate',
  'hazte','inscri','secretar','reservas','bookings?','oficina','\\boffice\\b',
  'ubicaci','localiza','donde','onde[-\\s_]estamos','como[-\\s_]?(llegar|chegar)',
  'find[-\\s_]?us','location','directions','how[-\\s_]to[-\\s_]find'
].join('|'), 'i');

const RE_TIER2 = new RegExp([
  'impressum','aviso[-\\s_]?legal','\\blegal\\b','privac','pol[ií]tica','\\bterms\\b','cookies?'
].join('|'), 'i');

function linkTier(url, text){
  const hay = String(url || '') + ' ' + String(text || '');
  if(RE_TIER0.test(hay)) return 0;
  if(RE_TIER1.test(hay)) return 1;
  if(RE_TIER2.test(hay)) return 2;
  return -1;
}

/* The word the prospector adds to its search for a country's clubs, so the
 * pages that publish an address rank first. Two words per language, taken
 * in turn across the search terms: "club de tenis Sevilla contacto" and
 * "club de padel Sevilla socios" rank different pages, and alternating
 * costs nothing — the same number of queries, asked two ways. Portugal
 * says "contactos" where Brazil says "contato".
 *
 * Never the word "email". It was the second word here from 2026-08-23 to
 * 2026-08-26, and DuckDuckGo answers any query containing it with its
 * anti-scraping challenge page — measured, deterministic, and independent
 * of pace or address: "padel club Antigua and Barbuda contact email" was
 * refused three times in a row while the same query without the word, and
 * its neighbours seven seconds apart, were all answered. Half of every
 * round's queries carried it, the refusals were read as rate limiting, the
 * rest between rounds ratcheted to an hour, and the search made
 * thirty-seven attempts in a day. The words below were each checked
 * against the same test. */
const SEARCH_WORDS = {
  Spanish:    ['contacto', 'socios'],
  Portuguese: ['contactos', 'sócios'],
  English:    ['contact', 'membership']
};
const SEARCH_WORDS_BY_CC = {
  BR: ['contato', 'associados']
};

function searchWord(lang, cc, i){
  const words = (cc && SEARCH_WORDS_BY_CC[cc]) || SEARCH_WORDS[lang] || SEARCH_WORDS.English;
  return words[(i || 0) % words.length];
}

module.exports = { CONTACT_PATHS, CONTACT_PATHS_BY_CC, contactPaths, placePaths,
                   linkTier, SEARCH_WORDS, SEARCH_WORDS_BY_CC, searchWord };
