'use strict';
/**
 * lib/place.js — which city a page is about
 * =========================================================================
 * The coverage tab counts emails per city, and it can only count a record
 * that carries one. The prospector stamps the city it searched for, but
 * the crawl, OpenStreetMap, the LTA register and the directories do not
 * know one — so the address on the contact page is read for it: a club in
 * Fortaleza prints Fortaleza in its footer whether or not anyone searched
 * for Fortaleza.
 *
 * Only names from lib/cities.json, in the record's own country, because
 * that is what the page joins on. Short names prove nothing — "York" is in
 * every page about New York, "Bath" in every page with a changing room —
 * so five characters or more, as whole words, longest name first. And a
 * city that is also an ordinary word — Barreiras is "barriers" in
 * Portuguese, and a squash club in Brasília was placed there on the
 * strength of one — has to appear either twice or inside an address:
 * after "Rua", "Calle", "Road", a postcode, a phone number.
 */

const CITIES = require('./cities.json');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const esc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Names that are far more often the ordinary word than the city, in any of
 * the three languages. Short list on purpose: Phoenix, Orange and Victoria
 * are real cities with real clubs and stay in, protected by the twice-or-
 * in-an-address rule. */
const STOP = new Set(['centro','barra','general','union','street','normal','independence','liberty',
                      'enterprise','reading','industrial','progreso','libertad','esperanca','bonito']);

/* What an address looks like around a city's name. After the name counts
 * for more than before it: "Juiz de Fora - MG 36000-000" is how a Brazilian
 * address ends, while "Rua das Flores" names a street, and Flores is a city
 * too. A year is not a postcode: five digits, or four with the Portuguese
 * -123, or a British one; a state code only right after the name. */
const RE_ADDR_BEFORE = /\b(rua|av|avenida|alameda|travessa|praca|largo|estrada|rodovia|calle|avda|paseo|plaza|carrer|carretera|camino|urb|road|street|lane|avenue|drive|close|court|way|rd|st|ave|cep|postcode|zip|tel|phone|telefone|telefono|contacto|contato|contact|endereco|direccion|address|ubicacion|localizacion|localizacao|sede|campus|cidade|ciudad|city|town|municipio|provincia|comarca|estado|distrito)\b[^a-z0-9]*(?:[a-z0-9]+[^a-z0-9]+){0,8}$/;
const RE_ADDR_AFTER  = /^[^a-z0-9]*(?:(?:[a-z0-9]+[^a-z0-9]+){0,2}(?:\d{5}(?:[^a-z0-9]?\d{3})?|\d{4}[^a-z0-9]\d{3}|[a-z]{1,2}\d[a-z\d]?[^a-z0-9]?\d[a-z]{2})|(?:sp|rj|mg|rs|pr|sc|ba|pe|ce|df|go|es|pa|pb|rn|mt|ms|al|se|pi|ma|to|am|ro|ac|ap|rr)(?![a-z0-9]))/;

const cache = new Map();

/* One alternation per country, longest name first so "San Isidro" wins over
 * any shorter city hiding inside it. Built once and kept. */
function matcher(cc){
  cc = String(cc || '').toUpperCase();
  if(cache.has(cc)) return cache.get(cc);
  const names = (CITIES[cc] || [])
    .map(c => ({c, n: norm(c).replace(/[^a-z0-9]+/g, ' ').trim()}))
    .filter(x => x.n.length >= 5 && !STOP.has(x.n))
    .sort((a, b) => b.n.length - a.n.length);
  const byNorm = new Map(names.map(x => [x.n, x.c]));
  const re = names.length
    ? new RegExp('(?:^|[^a-z0-9])(' + names.map(x => esc(x.n)).join('|') + ')(?![a-z0-9])', 'g')
    : null;
  const m = {re, byNorm};
  cache.set(cc, m);
  return m;
}

/* Every listed city the text names, scored: mentions, plus a bonus for
 * sitting inside what looks like an address. */
function scored(cc, text){
  const m = matcher(cc);
  if(!m.re || !text) return [];
  const hay = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const re = new RegExp(m.re.source, 'g');
  const score = new Map();
  let hit, n = 0;
  while((hit = re.exec(hay)) && n++ < 400){
    const c = m.byNorm.get(hit[1]);
    if(!c) continue;
    const start = hit.index + hit[0].length - hit[1].length;
    const before = hay.slice(Math.max(0, start - 90), start);
    const after  = hay.slice(start + hit[1].length, start + hit[1].length + 40);
    const s = score.get(c) || {c, count: 0, ctx: false, bonus: 0};
    s.count++;
    if(RE_ADDR_AFTER.test(after)){ s.ctx = true; s.bonus = Math.max(s.bonus, 4); }
    else if(RE_ADDR_BEFORE.test(before)){ s.ctx = true; s.bonus = Math.max(s.bonus, 2); }
    score.set(c, s);
  }
  return Array.from(score.values())
    .sort((a, b) => (b.bonus + b.count) - (a.bonus + a.count) || b.c.length - a.c.length);
}

/**
 * The city the text is about, or ''. Twice, or once inside an address —
 * one mention of a word that happens to be a city is not a place.
 */
function cityIn(cc, text){
  const best = scored(cc, text)[0];
  if(!best) return '';
  return (best.ctx || best.count >= 2) ? best.c : '';
}

/* Every listed city named in the text, best first. */
function citiesIn(cc, text, limit){
  return scored(cc, text).map(x => x.c).slice(0, limit || 5);
}

module.exports = { cityIn, citiesIn };
