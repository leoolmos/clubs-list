'use strict';
/**
 * The rules every source shares: which sports a place plays, whether it is a
 * private club, and how to get an email off a page.
 *
 * Kept in one file because the daemon, the one-shot harvester and the OSM
 * importer all have to agree. When they each had their own copy they drifted,
 * and a club rejected by one was accepted by another.
 */

/* ------------------------------------------------------------------ *
 * Sports
 * ------------------------------------------------------------------ */
/* Prefix matches, not whole words: clubs write the sport into compound
 * names — Tennisworld, Squashzone, TennisPro Academy — and requiring a word
 * boundary after the sport dropped every one of them. */
// Brazil spells it tênis, with a circumflex, and the class was blind to it:
// every Brazilian club naming its own sport correctly was read as having no
// racket sport at all, Tênis Clube de Santos among them.
const RE_TENNIS = /\bt[eéê]nn?is|lawn tennis/i;
const RE_PADEL  = /p[aá]del/i;
const RE_SQUASH = /\bsquash/i;

/* "padel tennis" and "paddle tennis" are padel, not tennis. Without this every
 * padel club in the database also claims to have tennis courts. */
const RE_PADEL_TENNIS = /p[aá]d(el|dle)[\s-]*tennis/i;

function detectSports(text){
  const t = String(text||'');
  const s = [];
  const padel = RE_PADEL.test(t) || RE_PADEL_TENNIS.test(t);
  const tennisOnlyFromPadel = RE_PADEL_TENNIS.test(t) && !RE_TENNIS.test(t.replace(RE_PADEL_TENNIS,' '));
  if(RE_TENNIS.test(t) && !tennisOnlyFromPadel) s.push('Tennis');
  if(padel) s.push('Padel');
  if(RE_SQUASH.test(t)) s.push('Squash');
  return s;
}

/* Same idea, from OSM's sport=* tag, which is a semicolon list */
function sportsFromTag(tag){
  const t = String(tag||'').toLowerCase();
  const s = [];
  if(/(^|;|\s)tennis(;|$|\s)/.test(t) && !/padel|paddle/.test(t.replace(/(^|;)tennis(;|$)/,''))) s.push('Tennis');
  else if(/\btennis\b/.test(t) && !/padel|paddle/.test(t)) s.push('Tennis');
  if(/padel|paddle/.test(t)) s.push('Padel');
  if(/squash/.test(t)) s.push('Squash');
  return Array.from(new Set(s));
}

/* ------------------------------------------------------------------ *
 * Private clubs only
 * ------------------------------------------------------------------ *
 * Two gates, because the brief is explicit: no community centres, no
 * council-run courts, no government facilities. A name gate and a domain
 * gate, and a record has to pass both.
 */

/* Run by a council, a government, a school, or open to the public by default */
const RE_PUBLIC = new RegExp([
  // local government, in all three languages
  'municipal','municipio','munic[ií]pio','ayuntamiento','ajuntament','concello','concejo',
  'c[aâ]mara municipal','prefeitura','alcald[ií]a','\\bcouncil\\b','\\bborough\\b',
  '\\bcity of\\b','\\bcounty\\b','\\btown of\\b','\\bvillage of\\b','\\bdistrict\\b',
  'parks (and|&) rec','\\bpublic (park|court|pool)','deportes municipales',
  // community and civic. These are single words on purpose: "Community
  // Tennis Centre" has a word between the two halves of "community centre"
  // and slipped through when the pattern required them adjacent.
  '\\bcommunity\\b','\\bcomunitari','\\brecreation\\b','\\brecreativ',
  'leisure cent','leisure center','civic cent','social club','\\bvillage hall\\b',
  'centro c[ií]vico','casa de la cultura','polideportivo','poliesportiu',
  'complejo deportivo municipal','centro deportivo municipal','\\bcharity\\b',
  '\\bnon-?profit\\b','\\bfoundation\\b','funda[cç][aã]o','fundaci[oó]n',
  // education
  'universidad','universidade','university','\\bcollege\\b','\\bschool\\b','\\bacademy of\\b',
  'colegio','col[eé]gio','instituto','escuela','escola','\\bcampus\\b','\\bstudent',
  // governing bodies, not clubs
  'federaci[oó]n','federa[cç][aã]o','federation','\\bassociation\\b','asociaci[oó]n',
  'associa[cç][aã]o','\\bconfedera','\\bleague\\b','\\bliga\\b','\\bcircuit\\b',
  // state and forces
  'ministerio','minist[eé]rio','gobierno','governo','\\bgovern','\\bstate of\\b',
  '\\bYMCA\\b','\\bYWCA\\b','\\barmy\\b','\\bnavy\\b','air force','\\bmilitary\\b',
  'defence','defense','\\bpolice\\b','\\bpolic[ií]a\\b','penitenci'
].join('|'),'i');

/* Domains that give it away regardless of the name */
const RE_PUBLIC_DOMAIN = new RegExp([
  '\\.gov(\\.|$)','\\.gob(\\.|$)','\\.gouv(\\.|$)','\\.gv\\.','\\.mil(\\.|$)',
  '\\.edu(\\.|$)','\\.ac\\.','\\.sch\\.','\\.k12\\.','\\.int(\\.|$)',
  'ayuntamiento','municipal','prefeitura','\\.council\\.','council\\.gov'
].join('|'),'i');

/* Positive signal that this is a club or a commercial venue rather than a
 * park with a court in it. A padel centre run as a business counts; a court
 * the council unlocks at nine counts as public and is dropped. */
const RE_CLUBWORD = new RegExp([
  '\\bclub\\b','\\bclube\\b','\\bclub[eu]','\\bcd\\b','\\bct\\b','country club',
  'racquet','racket','lawn tennis','tennis club','tenis club','t[eéê]nis club',
  'p[aá]del','padel','squash','sports? club','sporting','\\bacademy\\b','academia',
  'centre de tennis','centro de tenis','centro de t[eéê]nis','\\bcourts?\\b',
  '\\bclubhouse\\b','\\bindoor\\b','\\bcentre?\\b','\\bcenter\\b',
  // What a members' club calls itself where it does not call itself a club.
  // Círculo de Tenis de Montevideo has been one since 1919 and was rejected
  // for having no club signal in its name.
  '\\bc[ií]rculo\\b','\\bcircolo\\b','\\bcercle\\b',
  // Compound and abbreviated forms: "Miami Padelclub", "Padelcenter",
  // "LTC" — suffix matches, plus the two-letter club abbreviations.
  'club\\b','cent(er|re)\\b','\\btc\\b','\\bltc\\b'
].join('|'),'i');

/**
 * Decide whether a record is a private club.
 * Returns {ok:boolean, reason:string} — the reason is logged so a rejection
 * can be checked later rather than silently disappearing.
 */
function privateClub(rec){
  const name = String(rec.name||'');
  const hay  = [name, rec.operator||'', rec.description||''].join(' ');

  if(!name.trim()) return {ok:false, reason:'no name'};
  if(RE_PUBLIC.test(hay)) return {ok:false, reason:'public/institutional: '+(hay.match(RE_PUBLIC)||[''])[0]};

  const site = String(rec.website||'');
  if(site && RE_PUBLIC_DOMAIN.test(site)) return {ok:false, reason:'public domain'};

  const email = String(rec.email||'');
  if(email && RE_PUBLIC_DOMAIN.test(email.split('@')[1]||'')) return {ok:false, reason:'public email domain'};

  if(!RE_CLUBWORD.test(hay)) return {ok:false, reason:'no club signal in name'};

  return {ok:true, reason:''};
}

/* ------------------------------------------------------------------ *
 * Email extraction
 * ------------------------------------------------------------------ */
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}/gi;

const JUNK = new RegExp([
  '\\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$','@(2x|3x)\\.',
  'sentry','wixpress','example\\.(com|org|net)','yourdomain','domain\\.com',
  'godaddy','squarespace','wordpress\\.(com|org)','cloudflare','placeholder',
  '^email@','^test@','^user@','^name@','^your','sentry\\.io','\\.local$',
  'jquery','bootstrap','googlemail\\.com\\.',
  // template leftovers that show up on a surprising number of club sites
  'lorem','ipsum','@email\\.','@mail\\.com$','@domain'
].join('|'),'i');

/* Addresses that exist but are not a way to reach the club */
const RE_NOREPLY = /^(no-?reply|donot-?reply|postmaster|hostmaster|abuse|privacy|dmarc|dkim|spam|webmaster|wordpress|admin@localhost|sales@wix)/i;

/* Which local-part to prefer when a page publishes several */
const ROLE_PREFERENCE = [
  'info','contact','contacto','contato','geral','general','club','clube','clubhouse',
  'secretaria','secretariat','secretary','admin','administracion','administra[cç][aã]o',
  'reservas','reservations','bookings','hello','enquiries','enquiry','office','mail',
  'membership','socios','s[oó]cios','manager','gerencia','director'
];

/* Cloudflare's email obfuscation: the address is hex, xor'd with the first byte */
function cfDecode(hex){
  try{
    const key = parseInt(hex.substr(0,2),16);
    let out = '';
    for(let i=2;i<hex.length;i+=2) out += String.fromCharCode(parseInt(hex.substr(i,2),16) ^ key);
    return out;
  }catch(e){ return ''; }
}

function extractEmails(html, host){
  const src = String(html||'');
  const found = new Set();

  for(const m of src.match(/data-cfemail="([0-9a-f]+)"/gi)||[]){
    const h = m.match(/"([0-9a-f]+)"/i);
    if(h){ const d = cfDecode(h[1]); if(d.includes('@')) found.add(d.toLowerCase()); }
  }
  for(const m of src.match(/mailto:([^"'?\s>]+)/gi)||[]){
    found.add(decodeURIComponent(m.replace(/mailto:/i,'')).toLowerCase());
  }

  // "info [at] club [dot] com" and its many spellings
  const deob = src
    .replace(/&#0?64;/g,'@').replace(/&#0?46;/g,'.')
    .replace(/\s*[\[({]\s*(at|arroba|arobase)\s*[\])}]\s*/gi,'@')
    .replace(/\s*[\[({]\s*(dot|punto|ponto)\s*[\])}]\s*/gi,'.')
    .replace(/\s+(at)\s+/gi,'@').replace(/\s+(dot|punto|ponto)\s+/gi,'.');

  for(const e of src.match(EMAIL_RE)||[])  found.add(e.toLowerCase());
  for(const e of deob.match(EMAIL_RE)||[]) found.add(e.toLowerCase());

  const clean = Array.from(found)
    .map(e => e.replace(/^[^a-z0-9]+|[^a-z0-9._%+\-@]+$/gi,''))
    .map(e => e.replace(/\.$/,''))
    .filter(e => /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}$/i.test(e))
    .filter(e => e.length < 80)
    .filter(e => !JUNK.test(e))
    .filter(e => !RE_NOREPLY.test(e));

  const bare = host ? String(host).replace(/^www\./,'').toLowerCase() : '';
  const uniq = Array.from(new Set(clean));

  uniq.sort((a,b)=>{
    // an address on the club's own domain beats a gmail one in the footer
    const ad = bare && a.endsWith('@'+bare) ? 0 : 1;
    const bd = bare && b.endsWith('@'+bare) ? 0 : 1;
    if(ad !== bd) return ad - bd;
    const ar = ROLE_PREFERENCE.indexOf(a.split('@')[0]);
    const br = ROLE_PREFERENCE.indexOf(b.split('@')[0]);
    return (ar<0?99:ar) - (br<0?99:br);
  });
  return uniq;
}

/* A contact name, when the page prints one next to the address. Deliberately
 * conservative: a wrong name is worse than none, so it only fires on the
 * explicit label patterns. */
const RE_CONTACT_NAME = new RegExp(
  '(?:contacto|contato|contact|secretari[oa]|secretary|president[ea]?|gerente|manager|responsable|respons[aá]vel|director[a]?)' +
  '\\s*[:\\-–]\\s*([A-ZÁÉÍÓÚÑÂÃÊÔÇ][\\p{L}.\'\\-]+(?:\\s+[A-ZÁÉÍÓÚÑÂÃÊÔÇ][\\p{L}.\'\\-]+){1,3})',
  'iu');

function extractContactName(html){
  const text = String(html||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ');
  const m = text.match(RE_CONTACT_NAME);
  if(!m) return '';
  const n = m[1].trim();
  if(n.length < 4 || n.length > 60) return '';
  if(/\b(club|tennis|padel|squash|email|telefono|phone)\b/i.test(n)) return '';
  return n;
}

/* ------------------------------------------------------------------ *
 * Is this really the club's own website?
 * ------------------------------------------------------------------ *
 * A directory's club page carries the club's link and also the federation's
 * sponsors, its insurer, its energy supplier. Picking the first outbound
 * link gave two Basque tennis clubs "iberdrola.es" and "generali.es" as
 * their websites — and because records are keyed by website host, clubs
 * sharing a sponsor merged into a single record and the rest vanished.
 *
 * The check is name-to-domain overlap. A club's own domain almost always
 * contains a distinctive word from its name; a sponsor's never does.
 */

/* Words too common to prove anything */
const STOPWORDS = new Set([
  'club','clube','de','del','la','el','los','las','do','da','dos','das','of','the',
  'tenis','tennis','tenis','padel','padel','squash','sports','sport','deportivo',
  'real','centro','centre','center','ct','cd','and','y','e','lawn','racquet','racket',
  'asociacion','asoc','com','www','net','org',
  // compound one-word forms — as distinctive tokens they would match any
  // club's domain, which is the sponsor bug all over again
  'tennisclub','padelclub','squashclub','sportclub'
]);

function nameTokens(name){
  return String(name||'')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')   // strip accents
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

function plausibleSite(name, url){
  let host;
  try{ host = new URL(url).hostname.replace(/^www\./,'').toLowerCase(); }
  catch(e){ return false; }

  const flat = host.replace(/[^a-z0-9]/g,'');
  const toks = nameTokens(name);
  if(!toks.length) return false;

  // A whole distinctive word from the name inside the domain
  if(toks.some(t => flat.includes(t))) return true;

  // Or an acronym of the name: "Club de Tenis Amurrio" -> ctamurrio, cta
  const initials = String(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .split(/[^a-z0-9]+/).filter(Boolean).map(w=>w[0]).join('');
  if(initials.length >= 3 && flat.startsWith(initials)) return true;

  return false;
}

/* An email on the club's own domain is a better source for the website than
 * any link on the page: info@tegvitoria.com says the site is tegvitoria.com
 * and cannot be a sponsor. Free providers are excluded — a club on gmail
 * tells us nothing about its domain. */
const FREEMAIL = new Set([
  'gmail.com','googlemail.com','hotmail.com','hotmail.es','hotmail.co.uk','outlook.com',
  'outlook.es','live.com','yahoo.com','yahoo.es','yahoo.co.uk','yahoo.com.br','ymail.com',
  'aol.com','icloud.com','me.com','mail.com','gmx.com','gmx.net','protonmail.com','proton.me',
  'terra.com.br','uol.com.br','bol.com.br','ig.com.br','telefonica.net','orange.es',
  'mail.telepac.pt','sapo.pt','clix.pt','netcabo.pt','hotmail.com.ar','yahoo.com.ar',
  'zoho.com','yandex.com','free.fr','btinternet.com','sky.com','virginmedia.com','msn.com'
]);

function siteFromEmail(email){
  const dom = String(email||'').split('@')[1];
  if(!dom || FREEMAIL.has(dom.toLowerCase())) return '';
  if(!/^[a-z0-9.\-]+\.[a-z]{2,}$/i.test(dom)) return '';
  if(RE_PUBLIC_DOMAIN.test(dom)) return '';
  return 'https://' + dom.toLowerCase();
}

module.exports = {
  detectSports, sportsFromTag, privateClub, extractEmails, extractContactName,
  plausibleSite, siteFromEmail, nameTokens, FREEMAIL,
  RE_PUBLIC, RE_PUBLIC_DOMAIN, RE_CLUBWORD
};
