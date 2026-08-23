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
 * so five characters or more, as whole words, longest name first.
 */

const CITIES = require('./cities.json');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const esc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map();

/* One alternation per country, longest name first so "San Isidro" wins over
 * any shorter city hiding inside it. Built once and kept. */
function matcher(cc){
  cc = String(cc || '').toUpperCase();
  if(cache.has(cc)) return cache.get(cc);
  const names = (CITIES[cc] || [])
    .map(c => ({c, n: norm(c).replace(/[^a-z0-9]+/g, ' ').trim()}))
    .filter(x => x.n.length >= 5)
    .sort((a, b) => b.n.length - a.n.length);
  const byNorm = new Map(names.map(x => [x.n, x.c]));
  const re = names.length
    ? new RegExp('(?:^|[^a-z0-9])(' + names.map(x => esc(x.n)).join('|') + ')(?![a-z0-9])')
    : null;
  const m = {re, byNorm};
  cache.set(cc, m);
  return m;
}

/**
 * The first listed city named in the text, or ''. The text is flattened the
 * same way the names are, so accents and punctuation do not get in the way:
 * "Tênis Clube de Santos – Santos/SP" finds Santos.
 */
function cityIn(cc, text){
  const m = matcher(cc);
  if(!m.re || !text) return '';
  const hay = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const hit = m.re.exec(hay);
  return hit ? (m.byNorm.get(hit[1]) || '') : '';
}

/* Every listed city named in the text, most mentioned first — the contact
 * page of a club with two sites names both, and the footer names the one
 * the club calls home more often. */
function citiesIn(cc, text, limit){
  const m = matcher(cc);
  if(!m.re || !text) return [];
  const hay = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const re = new RegExp(m.re.source, 'g');
  const count = new Map();
  let hit;
  while((hit = re.exec(hay))){
    const c = m.byNorm.get(hit[1]);
    if(c) count.set(c, (count.get(c) || 0) + 1);
    if(count.size > 50) break;
  }
  return Array.from(count).sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, limit || 5);
}

module.exports = { cityIn, citiesIn };
