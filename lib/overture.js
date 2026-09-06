'use strict';
/**
 * Overture Maps importer — 74 million places, no key, no account
 * =========================================================================
 * OpenStreetMap was the only source that covered every country in the brief,
 * and it is the one that keeps failing: on the last recorded round, 88 of 93
 * countries were still pending and three had errored, because Overpass is a
 * handful of donated servers and a country-wide query is a lot to ask of
 * them. Meanwhile the seeds are exhausted and the crawl queue is down to
 * twenty sites. The collector is starved of new clubs, not of ways to find
 * emails for the ones it has.
 *
 * Overture is the answer to exactly that. It is the Linux Foundation's
 * open map data project — Meta, Microsoft, Amazon and Esri fund it — and
 * the places theme is 74 million POIs published as sixteen Parquet files in
 * a public S3 bucket. There is no query service to overload and nothing to
 * sign up for: it is static files over HTTPS, and it either downloads or it
 * does not.
 *
 * Three things make it worth the work of reading Parquet by hand:
 *
 *   It carries the contact fields directly. `emails`, `websites`, `socials`
 *   are columns in the schema. Every other source in this repository gives
 *   a name and then costs a site crawl to find an address; a fair share of
 *   Overture rows arrive with the email already in them.
 *
 *   It does not contain OpenStreetMap. Overture says so in as many words,
 *   and it means the two importers cannot be duplicating each other's work.
 *   Its places come from Meta (about 58 million), Microsoft, Foursquare and
 *   PinMeTo — commercial POI sets with the contact details OSM rarely has,
 *   and with coverage in Latin America and Africa where OSM is thin and the
 *   database is thinnest.
 *
 *   The licence is CDLA Permissive 2.0 and Apache 2.0, with, in Overture's
 *   own words, "none of the share-alike obligations of the ODbL". That
 *   matters here: OSM's licence means a database derived from it has to be
 *   released under the same terms if it is distributed, which is why the OSM
 *   importer is treated as a source of candidates. This one has no such
 *   condition attached.
 *
 * Foursquare's own release was the other candidate and is deliberately not
 * used. Its public S3 bucket now answers a listing of `release/` with zero
 * keys — the data moved to a gated Hugging Face dataset in early 2026, which
 * means a form, an account and a token. Nothing else in this repository
 * needs an account and this would be the only thing that did, for a dataset
 * that is already one of Overture's four upstream providers.
 *
 *   node lib/overture.js --index      build or refresh the row-group index
 *   node lib/overture.js --status     what has been read so far
 *   node lib/overture.js --scan       read a slice and report, without saving
 *   node lib/overture.js --import     read a slice and save what it finds
 * =========================================================================
 */

const fs   = require('fs');
const path = require('path');
const pq   = require('./parquet');
const { COUNTRIES, isWanted, nameOf, langOf } = require('./countries');
const { detectSports, sportsFromTag, namesOtherSport, privateClub } = require('./classify');

const ROOT       = path.join(__dirname, '..');
const DATA_DIR   = path.join(ROOT, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'overture-index.json');
const STATE_FILE = path.join(DATA_DIR, 'overture-state.json');
const LEADS_FILE = path.join(DATA_DIR, 'overture-leads.json');

const BUCKET = 'https://overturemaps-us-west-2.s3.amazonaws.com';
const UA = require('./http').UA;   // one contact string for every fetcher, see http.js

/* This is a static bucket meant to be read in bulk — Overture's own
 * instructions have people pulling hundreds of megabytes through DuckDB —
 * so the restraint here is about rate, not about refusing to use it. A few
 * row groups in flight at once, a floor on how close together requests may
 * start, and a ceiling on how much one round may pull. */
const REQUEST_GAP_MS = parseInt(process.env.OVERTURE_GAP_MS || '50', 10);
const DEFAULT_PARALLEL = parseInt(process.env.OVERTURE_PARALLEL || '4', 10);
const HTTP_TIMEOUT_MS = 90000;
const DEFAULT_BUDGET_MB = parseInt(process.env.OVERTURE_MB || '150', 10);

/* ------------------------------------------------------------------ *
 * Where the countries are
 * ------------------------------------------------------------------ *
 * Row groups carry the bounding box of what they hold, and the file is
 * sorted west to east, so a box test is what turns a 10.5 GB dataset into
 * a few megabytes per country. These boxes only have to be generous, never
 * exact: which country a place is actually in is decided further down by
 * the ISO code in its own address, so a box that is too big costs bandwidth
 * and a box that is too small is the only real mistake.
 *
 * Written [west, south, east, north]. A country either side of the
 * antimeridian gets two boxes rather than one that wraps — Fiji written as
 * one box from 177E to -178E spans the entire globe the wrong way round and
 * would drag in every row group on earth.
 */
const BOXES = {
  /* Spanish */
  AR:[[-73.6,-55.2,-53.6,-21.7]], BO:[[-69.7,-23.0,-57.4,-9.6]], CL:[[-75.8,-56.0,-66.3,-17.4]],
  CO:[[-79.1,-4.3,-66.8,12.7]],   CR:[[-86.0,7.9,-82.5,11.3]],   CU:[[-85.1,19.7,-74.0,23.4]],
  DO:[[-72.1,17.4,-68.2,20.1]],   EC:[[-92.1,-5.1,-75.1,1.6]],   SV:[[-90.3,13.0,-87.6,14.6]],
  GQ:[[5.4,-1.6,11.4,3.9]],       GT:[[-92.4,13.6,-88.1,18.0]],  HN:[[-89.5,12.8,-83.0,16.7]],
  MX:[[-118.6,14.4,-86.6,32.9]],  NI:[[-87.8,10.6,-82.5,15.2]],  PA:[[-83.2,7.0,-77.0,9.8]],
  PY:[[-62.8,-27.8,-54.1,-19.1]], PE:[[-81.5,-18.5,-68.5,0.1]],  ES:[[-18.4,27.4,4.5,44.0]],
  UY:[[-58.6,-35.2,-52.9,-29.9]], VE:[[-73.5,0.5,-59.6,12.7]],   PR:[[-67.4,17.7,-65.1,18.7]],

  /* Portuguese */
  AO:[[11.5,-18.2,24.2,-4.2]],    BR:[[-74.2,-33.9,-34.6,5.4]],  CV:[[-25.5,14.7,-22.5,17.4]],
  TL:[[123.9,-9.7,127.5,-8.0]],   GW:[[-16.9,10.7,-13.5,12.8]],  MZ:[[30.1,-27.1,41.1,-10.3]],
  PT:[[-31.6,32.3,-6.0,42.3]],    ST:[[6.3,-0.2,7.6,1.9]],

  /* English */
  AG:[[-62.1,16.8,-61.5,17.9]],   AU:[[112.8,-43.8,153.8,-9.9]], BS:[[-79.2,20.8,-72.6,27.4]],
  BB:[[-59.8,12.9,-59.3,13.5]],   BZ:[[-89.4,15.7,-87.6,18.6]],  BW:[[19.8,-27.1,29.5,-17.7]],
  CA:[[-141.2,41.5,-52.5,83.3]],  DM:[[-61.6,15.1,-61.1,15.8]],
  FJ:[[176.7,-20.8,180.0,-12.3],[-180.0,-20.8,-177.8,-15.5]],
  GM:[[-17.1,12.9,-13.6,14.0]],   GH:[[-3.4,4.6,1.3,11.3]],      GD:[[-61.9,11.8,-61.3,12.7]],
  GY:[[-61.5,1.0,-56.4,8.7]],     IN:[[68.0,6.4,97.5,35.7]],     IE:[[-10.7,51.3,-5.8,55.5]],
  JM:[[-78.5,17.6,-76.1,18.7]],   KE:[[33.8,-4.8,42.0,5.6]],
  KI:[[168.9,-11.6,180.0,4.9],[-180.0,-11.6,-149.9,4.9]],
  LS:[[26.9,-30.8,29.6,-28.4]],   LR:[[-11.6,4.2,-7.3,8.7]],     MW:[[32.6,-17.3,36.0,-9.3]],
  MT:[[14.0,35.7,14.7,36.2]],     MH:[[160.7,4.4,172.1,14.8]],   MU:[[56.4,-20.7,63.7,-10.2]],
  FM:[[137.1,0.9,163.2,10.1]],    NA:[[11.6,-29.1,25.4,-16.8]],  NR:[[166.7,-0.7,167.1,-0.4]],
  NZ:[[166.2,-47.5,179.2,-33.9],[-177.1,-44.5,-175.7,-43.6]],
  NG:[[2.5,4.1,14.8,14.0]],       PK:[[60.7,23.5,78.0,37.2]],    PW:[[131.0,2.7,134.8,8.2]],
  PG:[[140.7,-11.8,156.0,-1.2]],  PH:[[116.8,4.5,126.7,21.2]],   RW:[[28.7,-3.0,31.0,-0.9]],
  KN:[[-63.0,17.0,-62.4,17.5]],   LC:[[-61.2,13.6,-60.8,14.2]],  VC:[[-61.6,12.4,-61.0,13.5]],
  WS:[[-172.9,-14.2,-171.3,-13.3]], SC:[[46.1,-10.3,56.4,-3.6]], SL:[[-13.4,6.8,-10.2,10.1]],
  SG:[[103.5,1.1,104.2,1.6]],     SB:[[155.4,-12.4,167.1,-6.5]], ZA:[[16.3,-35.0,33.1,-22.0]],
  SS:[[24.0,3.4,36.0,12.3]],      SD:[[21.7,8.6,38.7,22.3]],     TZ:[[29.2,-11.9,40.6,-0.8]],
  TO:[[-176.4,-22.5,-173.6,-15.4]], TT:[[-62.0,9.9,-60.4,11.5]], TV:[[175.9,-10.9,180.0,-5.5]],
  UG:[[29.4,-1.6,35.2,4.4]],      GB:[[-8.8,49.7,2.0,61.0]],
  US:[[-125.1,24.3,-66.8,49.5],[-172.6,51.1,-129.8,71.6],[-160.4,18.8,-154.7,22.4]],
  VU:[[166.4,-20.4,170.4,-12.9]], ZM:[[21.8,-18.2,33.8,-8.1]],   ZW:[[25.1,-22.6,33.2,-15.5]],

  /* The 2026 additions */
  AE:[[51.4,22.5,56.5,26.2]],     CY:[[32.1,34.4,34.7,35.8]],    EG:[[24.6,21.9,37.0,31.8]],
  HK:[[113.7,22.0,114.6,22.7]],   BM:[[-65.0,32.1,-64.5,32.5]],  KY:[[-81.6,19.1,-79.6,19.9]],
  GI:[[-5.5,36.0,-5.2,36.3]],     JE:[[-2.4,49.0,-1.9,49.4]],    IM:[[-5.0,53.9,-4.2,54.6]]
};

/* ------------------------------------------------------------------ *
 * Which columns, and in two passes
 * ------------------------------------------------------------------ *
 * Reading everything for every row group costs about 0.92 MB. Reading only
 * enough to know whether a row group holds any racket club at all costs
 * 0.30 MB, and most of the world's row groups hold none that are in a
 * wanted country. So the name, the category and the country code go in the
 * first pass, and the expensive columns — the contact details — are only
 * fetched for a row group that has something in it worth the bytes.
 */
const SCAN_COLUMNS = [
  'names.primary',
  'categories.primary',
  'addresses.list.element.country'
];
const DETAIL_COLUMNS = [
  'websites.list.element',
  'emails.list.element',
  'socials.list.element',
  'addresses.list.element.locality',
  'categories.alternate.list.element',
  'confidence',
  // A lead with no website is only useful if something can be searched for
  // near it, so a club with nothing but a name keeps its coordinates.
  'bbox.xmin',
  'bbox.ymin'
];
const ALL_COLUMNS = SCAN_COLUMNS.concat(DETAIL_COLUMNS);

/* The columns the index has to remember byte ranges for, plus the two the
 * pruning itself needs. */
const BBOX_COLUMNS = ['bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax'];

/**
 * Categories that are a racket sport on their own, whatever the name says.
 *
 * Overture's taxonomy is a flat snake_case string per place. A club is very
 * often filed under something vague — measured on one Mexican row group,
 * "Squash Kufo" is `active_life` and "Jardín padelu" is `restaurant` — so
 * the category is a way in, not the test. The name carries at least as much,
 * and both feed the same sport detection the rest of the repository uses.
 */
/* Matched on snake_case word boundaries, not `\b`. An underscore is a word
 * character to a regexp, so `\btennis\b` does not match inside
 * "tennis_court" — which would have thrown away the best case this source
 * has: a club whose name says nothing ("Club Deportivo Los Pinos") and
 * whose category says everything. */
const RACKET_CATEGORY = /(^|_)(tennis|padel|paddle|squash|pickleball|racquet|racquetball|racket)(_|$)/;

/* Categories that are a venue of some kind, where a racket word in the name
 * is worth believing. Without this, "Padel" in the name of a bus stop
 * becomes a club. */
const VENUE_CATEGORY = new RegExp([
  'tennis','padel','paddle','squash','pickleball','racquet','racket','country_club','sports_club',
  'athletic','gym','fitness','recreation','sports_and_recreation','active_life',
  'stadium_arena','sports_complex','leisure','club','court','coach','sport'
].join('|'));

/* Shops. Overture files a padel retailer under `sporting_goods` and a racket
 * stringer under `sports_wear`, and both contain "sport", so the venue test
 * above waves them through — the first Brazilian scan offered "Tienda de
 * Padel", "Tenislândia" and "Gabriel Import Tênis" as clubs. A shop is never
 * filed as `tennis_court`, so this is checked before anything else and
 * rejects outright rather than merely failing the venue test. */
const RETAIL_CATEGORY = new RegExp([
  'sporting_goods','sports_wear','shopping','shop','store','retail','market','mall',
  'boutique','wholesale','manufactur','distributor','supplier','pawn','e_commerce'
].join('|'));

/* Shops the category does not catch, because the category is right and the
 * place is not what it says. "TÊNis Viral Modas" is filed as `tennis_court`
 * and sells clothes off a MercadoLivre link; nothing in the taxonomy gives
 * that away, and only the name does. Kept to words that mean trade and
 * nothing else in the three languages — "loja", "tienda", "modas" — because
 * a club really can be called anything. */
const RETAIL_NAME = new RegExp([
  '\\bmodas?\\b','\\bloja\\b','\\btienda\\b','\\bstore\\b','\\bshop\\b','\\bboutique\\b',
  '\\boutlet\\b','\\bmagazine\\b','\\bimportados?\\b','\\bdistribuidora\\b','\\batacado\\b',
  'artigos esportivos','art[ií]culos deportivos','sport ?wear','pro ?shop','\\bvendas?\\b'
].join('|'), 'i');

/* A name that describes a facility rather than names a club: "Quadras de
 * Tênis", "Cancha de Padel", "Squash". These are real — they are the courts
 * inside something bigger — and they are worth reading, because keyed by
 * website they add the squash court to a club already on file. What they
 * must never do is start a record of their own: the same row against a
 * hotel's website invents "Quadras de Tênis" as a Brazilian tennis club,
 * and a hotel with a court is not a club. So they are allowed to merge and
 * not to create. */
const GENERIC_NAME = new RegExp(
  '^(?:(?:quadras?|canchas?|pistas?|courts?|campos?|courts?\\s+de)\\s+(?:de\\s+)?)?' +
  '(?:t[eéê]nn?is|p[aá]del|squash|pickle\\s?ball|racquetball)' +
  '(?:\\s+(?:courts?|quadras?|canchas?|pistas?))?$', 'i');

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function readJSON(f, fallback){
  if(!fs.existsSync(f)) return fallback;
  try{ return JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ return fallback; }
}
function writeJSON(f, o){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(f, JSON.stringify(o));
}

/* ------------------------------------------------------------------ *
 * HTTP, one range at a time
 * ------------------------------------------------------------------ */
let bytesPulled = 0;
let lastRequest = 0;

/**
 * The pace, held as a chain rather than a timestamp.
 *
 * Reading a timestamp, sleeping the difference and then writing it back is
 * three steps with an await in the middle, and with several workers running
 * that is a race: each computes the same gap from the same stale timestamp,
 * they all sleep the same amount and they all fire together, which is the
 * burst the gap exists to prevent. Queueing each request behind the last
 * one's turn instead makes the spacing hold however many workers there are.
 */
let turn = Promise.resolve();
function takeTurn(){
  turn = turn.then(async () => {
    const gap = REQUEST_GAP_MS - (Date.now() - lastRequest);
    if(gap > 0) await sleep(gap);
    lastRequest = Date.now();
  });
  return turn;
}

async function httpGet(url, headers, timeoutMs){
  await takeTurn();

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || HTTP_TIMEOUT_MS);
  try{
    return await fetch(url, {headers: Object.assign({'User-Agent': UA}, headers || {}), signal: ctl.signal});
  } finally { clearTimeout(t); }
}

/**
 * A byte-range reader for one file.
 *
 * S3 answers a range request with 206 and the bytes asked for. A 200 means
 * the range was ignored and the whole 635 MB file is on its way, which is
 * not a slow success — it is a failure that would fill the disk, so it is
 * refused rather than read.
 */
function rangeReader(url){
  return async (from, to) => {
    let lastErr = null;
    for(let attempt = 0; attempt < 3; attempt++){
      try{
        const r = await httpGet(url, {Range: `bytes=${from}-${to}`});
        if(r.status === 200) throw new Error('range request ignored, refusing the whole file');
        if(r.status !== 206) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        bytesPulled += buf.length;
        return buf;
      }catch(e){
        lastErr = e;
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    throw new Error('range ' + from + '-' + to + ': ' + lastErr.message);
  };
}

/* ------------------------------------------------------------------ *
 * Finding the current release
 * ------------------------------------------------------------------ */
async function listPrefix(prefix, delimiter){
  const out = {keys: [], prefixes: []};
  let token = '';
  for(let page = 0; page < 40; page++){
    let u = BUCKET + '/?list-type=2&prefix=' + encodeURIComponent(prefix);
    if(delimiter) u += '&delimiter=' + encodeURIComponent(delimiter);
    if(token) u += '&continuation-token=' + encodeURIComponent(token);

    const r = await httpGet(u, null, 30000);
    if(!r.ok) throw new Error('bucket listing: HTTP ' + r.status);
    const xml = await r.text();

    /* One <Contents> block per object, and the elements inside it are not
     * in a fixed order or a fixed set — S3 slips <ChecksumAlgorithm> and
     * <ChecksumType> between the ETag and the Size, which a single regexp
     * spanning both quietly fails to match. Matching the block first and
     * then each field inside it survives whatever else appears there. */
    for(const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)){
      const key = (block[1].match(/<Key>([^<]+)<\/Key>/) || [])[1];
      const size = (block[1].match(/<Size>(\d+)<\/Size>/) || [])[1];
      if(key) out.keys.push({key, size: parseInt(size || '0', 10)});
    }
    for(const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g))
      out.prefixes.push(m[1]);

    if(!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1];
    if(!token) break;
  }
  return out;
}

/**
 * The newest release that actually has a places theme in it.
 *
 * Releases appear in the bucket before every theme has finished uploading,
 * so the newest prefix is not always one that can be read. Walking back from
 * the newest until a places directory with files in it turns up costs two
 * cheap listings and avoids a round that reads nothing and reports the
 * dataset as broken.
 */
async function latestRelease(){
  const {prefixes} = await listPrefix('release/', '/');
  const releases = prefixes
    .map(p => p.replace(/^release\//, '').replace(/\/$/, ''))
    .filter(r => /^\d{4}-\d{2}-\d{2}/.test(r))
    .sort()
    .reverse();

  for(const rel of releases.slice(0, 4)){
    const prefix = `release/${rel}/theme=places/type=place/`;
    const {keys} = await listPrefix(prefix, null);
    const parts = keys.filter(k => /\.parquet$/.test(k.key) && k.size > 1000);
    if(parts.length) return {release: rel, files: parts};
  }
  throw new Error('no Overture release with a places theme in it');
}

/* ------------------------------------------------------------------ *
 * The index
 * ------------------------------------------------------------------ *
 * Sixteen footers, 1.6 MB each. Reading them every round would be 26 MB
 * spent before a single club is found, so what they say is boiled down once
 * per release into one file: for each row group, the box it covers and the
 * byte range of each column worth reading. That is the whole of what the
 * importer needs, and it makes a round's first act a disk read.
 */
async function buildIndex(log){
  const say = log || (() => {});
  const {release, files} = await latestRelease();
  const existing = readJSON(INDEX_FILE, null);
  if(existing && existing.release === release && existing.files && existing.files.length === files.length){
    say(`overture: index already current for release ${release}`);
    return existing;
  }

  say(`overture: indexing release ${release}, ${files.length} files, ` +
      `${(files.reduce((n, f) => n + f.size, 0) / 1e9).toFixed(1)} GB`);

  const out = {release, built: new Date().toISOString(), files: []};
  for(const f of files){
    const url = BUCKET + '/' + f.key.split('/').map(encodeURIComponent).join('/');
    const md = await pq.readFooter(rangeReader(url), f.size);

    const schema = {};
    for(const p of ALL_COLUMNS.concat(BBOX_COLUMNS)){
      const leaf = md.schema.byPath.get(p);
      if(leaf) schema[p] = {type: leaf.type, maxDef: leaf.maxDef, maxRep: leaf.maxRep};
    }
    /* A release that drops or renames a column we depend on has to be
     * noticed here, not by producing an import of nothing. */
    for(const p of SCAN_COLUMNS)
      if(!schema[p]) throw new Error(`overture: release ${release} has no column "${p}"`);

    const groups = [];
    for(const rg of md.rowGroups){
      const x0 = pq.doubleStats(rg.columns.get('bbox.xmin'));
      const x1 = pq.doubleStats(rg.columns.get('bbox.xmax'));
      const y0 = pq.doubleStats(rg.columns.get('bbox.ymin'));
      const y1 = pq.doubleStats(rg.columns.get('bbox.ymax'));
      if(!x0 || !y0) throw new Error(`overture: release ${release} has no bbox statistics to prune by`);

      const cols = {};
      for(const p of ALL_COLUMNS){
        const c = rg.columns.get(p);
        if(c) cols[p] = [c.start, c.compressedSize, c.codec];
      }
      groups.push({
        rows: rg.numRows,
        lon: [x0.min, x1 ? x1.max : x0.max],
        lat: [y0.min, y1 ? y1.max : y0.max],
        c: cols
      });
    }

    out.files.push({key: f.key, url, size: f.size, schema, groups});
    say(`overture: ${f.key.split('/').pop()} — ${md.rowGroups.length} row groups, ` +
        `${(md.numRows / 1e6).toFixed(1)}M places`);
  }

  writeJSON(INDEX_FILE, out);
  const total = out.files.reduce((n, f) => n + f.groups.length, 0);
  say(`overture: index built — ${total} row groups over ${out.files.length} files`);
  return out;
}

/* ------------------------------------------------------------------ *
 * Choosing what to read
 * ------------------------------------------------------------------ */
function boxesFor(cc){ return BOXES[cc] || []; }

function overlaps(group, box){
  return group.lon[1] >= box[0] && group.lon[0] <= box[2] &&
         group.lat[1] >= box[1] && group.lat[0] <= box[3];
}

/** Every wanted country whose box touches this row group. */
function countriesIn(group){
  const hit = [];
  for(const cc of Object.keys(BOXES))
    if(boxesFor(cc).some(b => overlaps(group, b))) hit.push(cc);
  return hit;
}

/**
 * The row groups still to read, least-covered country first.
 *
 * Order is taken from the database rather than a fixed list, because the
 * point of a new source is the gap: Vanuatu at zero is worth more per
 * megabyte than Spain at 1,218, and by the time Spain is the thinnest
 * country left the ordering has said so by itself.
 */
function workList(index, state, db, only){
  const clubsPerCC = {};
  for(const rec of Object.values(db || {})){
    if(rec && rec.cc) clubsPerCC[rec.cc] = (clubsPerCC[rec.cc] || 0) + 1;
  }
  const wanted = only && only.length ? new Set(only.map(c => c.toUpperCase())) : null;

  const done = state.done || {};
  const work = [];
  index.files.forEach((file, fi) => {
    const finished = new Set(done[fi] || []);
    file.groups.forEach((g, gi) => {
      if(finished.has(gi)) return;
      let ccs = countriesIn(g);
      if(wanted) ccs = ccs.filter(cc => wanted.has(cc));
      if(!ccs.length) return;
      const thinnest = Math.min.apply(null, ccs.map(cc => clubsPerCC[cc] || 0));
      work.push({fi, gi, group: g, ccs, thinnest, rows: g.rows});
    });
  });

  work.sort((a, b) => a.thinnest - b.thinnest || a.rows - b.rows);
  return work;
}

/* ------------------------------------------------------------------ *
 * Row -> record
 * ------------------------------------------------------------------ */
function firstString(v){
  if(!v) return '';
  if(Array.isArray(v)) return v.length ? String(v[0]).trim() : '';
  return String(v).trim();
}

/**
 * A website worth crawling.
 *
 * The same rule as the OSM importer: a social profile is not a site the
 * crawler can read an address out of, and records are keyed by website host,
 * so letting facebook.com through would collapse every club that links to
 * its own Facebook page into a single record.
 */
function normaliseSite(u){
  if(!u) return '';
  let s = String(u).trim().split(/[\s,;]+/)[0];
  if(/^www\./i.test(s)) s = 'http://' + s;
  if(!/^https?:\/\//i.test(s)) return '';
  try{
    const url = new URL(s);
    if(!url.hostname.includes('.')) return '';
    if(/facebook|instagram|twitter|x\.com|linktr\.ee|tiktok|youtube|wa\.me|whatsapp/i.test(url.hostname)) return '';
    /* A marketplace listing or a shortened link is not the club's site, and
     * because records are keyed by host it is worse than useless: every club
     * that ever linked to MercadoLivre would collapse into one record.
     * "TÊNis Viral Modas" arrived with nothing but a meli.la link. */
    if(/^(meli\.la|mercadolivre|mercadolibre|shopee|amazon|olx|bit\.ly|goo\.gl|t\.co|tinyurl)/i
       .test(url.hostname.replace(/^www\./, ''))) return '';
    if(/mercadoli[bv]re|shopee|aliexpress|ebay|etsy/i.test(url.hostname)) return '';
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  }catch(e){ return ''; }
}

/* Overture's social links are the club's own pages, and while they are not
 * crawlable for an address they are worth keeping: a Facebook page is often
 * the only web presence a club in Malawi or Guyana has, and the search side
 * of the collector can use it. */
function socialOf(list){
  if(!Array.isArray(list)) return '';
  for(const s of list) if(/facebook|instagram/i.test(String(s))) return String(s).trim();
  return list.length ? String(list[0]).trim() : '';
}

/**
 * Turn one Overture row into a record, or say why not.
 *
 * The gates are the repository's own, unchanged: `detectSports` decides what
 * is played, `privateClub` decides whether it is a club rather than a park
 * or a school. The category is folded into the description in the same shape
 * OSM's `leisure` and `club` tags are, with the underscores opened out —
 * "tennis_court" is one word to a regexp and matches nothing, "tennis court"
 * is what every rule in classify.js was written against.
 */
function toRecord(row, cc){
  const name = firstString(row.name);
  if(!name || name.length < 2) return null;

  const rawCategory = String(row.category || '');
  const rawAlternates = (row.alternates || []).join(' ');
  const category = rawCategory.replace(/_/g, ' ');
  const alternates = (row.alternates || []).map(a => String(a).replace(/_/g, ' ')).join(' ');

  const byCategory = RACKET_CATEGORY.test(rawCategory) ||
                     (rawAlternates ? rawAlternates.split(/\s+/).some(a => RACKET_CATEGORY.test(a)) : false);
  const isVenue    = VENUE_CATEGORY.test(rawCategory) || VENUE_CATEGORY.test(rawAlternates);

  /* Shops. The primary category is always checked; the alternates are only
   * checked when the primary is not explicitly a racket venue, because a
   * tennis club with a pro shop carries `sporting_goods` as an alternate and
   * is still a tennis club. */
  if(RETAIL_CATEGORY.test(rawCategory))
    return {reject: 'a shop, not a club: ' + rawCategory};
  if(!byCategory && RETAIL_CATEGORY.test(rawAlternates))
    return {reject: 'a shop, not a club: ' + rawAlternates};
  if(RETAIL_NAME.test(name))
    return {reject: 'a shop by its name: ' + name};

  /* The category and the name each get a say, read through the same rules
   * the rest of the repository uses — which now know that table tennis,
   * beach tennis, racquetball, badminton and frontón are not the four sports
   * this database is about.
   *
   * Where they disagree the name wins. Overture's categories are coarse and
   * a table-tennis hall filed as `tennis_court` is exactly the kind of row
   * that would otherwise be published as a tennis club: if the name names an
   * excluded sport and none of the four, no category rescues it. */
  const fromCategory = sportsFromTag(category + ' ' + alternates);
  const fromName     = detectSports(name);

  if(namesOtherSport(name) && !fromName.length)
    return {reject: 'a racket sport that is not one of the four: ' + name};

  const sports = Array.from(new Set(fromCategory.concat(fromName)));
  if(!sports.length) return null;

  /* A racket word in a name proves nothing on its own — "Squash Lane" is a
   * street and "Padel" is somebody's surname — so a place the category does
   * not place at a venue of some kind is turned down. */
  if(!fromCategory.length && !byCategory && !isVenue)
    return {reject: 'racket word in the name but not a venue: ' + rawCategory};

  const website = normaliseSite(firstString(row.websites));
  const email   = String(firstString(row.emails) || '').toLowerCase().split(/[\s,;]+/)[0];
  const social  = socialOf(row.socials);

  const verdict = privateClub({
    name, website, email,
    description: [category, alternates].join(' ')
  });
  if(!verdict.ok) return {reject: verdict.reason};

  /* Every other source can point at the page a record came from. This one
   * cannot: an Overture place lives in a Parquet file, not on a page, and
   * there is no per-place URL to link to. So it has no `srcPage` at all —
   * it briefly held a link to Overture's documentation, which is true and
   * useless, and put "found on docs.overturemaps.org" against every record
   * on the page. `src` already says where it came from; the release says
   * which copy of it. */
  const rec = {
    name, cc, country: nameOf(cc), lang: langOf(cc), sports,
    website, email, contact: '',
    src: 'overture',
    release: row.release || '',
    crawled: !!email,
    attempts: 0
  };

  if(row.city) rec.city = String(row.city);

  /* Read but never published on its own — see GENERIC_NAME. The caller
   * enforces it, because whether a merge is possible is a question about the
   * database and this function only knows about the row. */
  if(GENERIC_NAME.test(name.trim())) rec.mergeOnly = true;

  /* No website and no email is not a result, but it is a real club with a
   * name and a town, which is exactly what the search side needs to go and
   * find the site. A social page counts as a lead too, not as a website. */
  if(!website && !email){
    rec.social = social;
    rec.town = row.city ? String(row.city) : '';
    rec.lat = row.lat; rec.lon = row.lon;
    return {lead: rec};
  }
  if(social) rec.social = social;

  return rec;
}

/* The same key rule as the daemon and the OSM importer, so the three merge
 * cleanly instead of each other's duplicates. */
function keyFor(rec){
  if(rec.website){
    try{ return 'w:' + new URL(rec.website).hostname.replace(/^www\./, '').toLowerCase(); }catch(e){}
  }
  if(rec.email) return 'e:' + rec.email;
  return 'n:' + rec.cc + ':' + String(rec.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* ------------------------------------------------------------------ *
 * Reading one row group
 * ------------------------------------------------------------------ */
function rowGroupFor(file, group, paths){
  const columns = new Map();
  for(const p of paths){
    const c = group.c[p];
    const s = file.schema[p];
    if(!c || !s) continue;
    columns.set(p, {path: p, type: s.type, codec: c[2], start: c[0], compressedSize: c[1]});
  }
  return {numRows: group.rows, columns};
}

function schemaFor(file, paths){
  const byPath = new Map();
  for(const p of paths) if(file.schema[p]) byPath.set(p, Object.assign({path: p}, file.schema[p]));
  return {byPath};
}

/**
 * Read one row group and return the racket places in it that sit in a wanted
 * country.
 *
 * The scan pass reads name, category and country code — about a third of the
 * cost — and only if something survives that does the second pass go back
 * for the contact columns. On a row group in the middle of the Pacific, or
 * one that is entirely in a country not in the brief, the second pass never
 * happens.
 */
async function readGroup(file, group){
  const reader = rangeReader(file.url);
  const scan = await pq.readColumns(reader, rowGroupFor(file, group, SCAN_COLUMNS),
                                    schemaFor(file, SCAN_COLUMNS), SCAN_COLUMNS);

  const names = scan['names.primary'] || [];
  const cats  = scan['categories.primary'] || [];
  const ctry  = scan['addresses.list.element.country'] || [];

  const candidates = [];
  for(let i = 0; i < group.rows; i++){
    const cc = firstString(ctry[i]).toUpperCase();
    if(!cc || !isWanted(cc)) continue;

    const name = names[i];
    const cat  = cats[i] || '';
    if(!name) continue;
    // Cheap first cut: something here has to look like a racket sport at all.
    if(!RACKET_CATEGORY.test(cat) && !detectSports(name).length) continue;
    candidates.push({i, cc, name, category: cat});
  }

  if(!candidates.length) return {candidates: [], rows: []};

  const detail = await pq.readColumns(reader, rowGroupFor(file, group, DETAIL_COLUMNS),
                                      schemaFor(file, DETAIL_COLUMNS), DETAIL_COLUMNS);
  const rows = candidates.map(c => ({
    cc: c.cc,
    name: c.name,
    category: c.category,
    alternates: (detail['categories.alternate.list.element'] || [])[c.i] || [],
    websites: (detail['websites.list.element'] || [])[c.i] || null,
    emails:   (detail['emails.list.element'] || [])[c.i] || null,
    socials:  (detail['socials.list.element'] || [])[c.i] || null,
    city:     firstString((detail['addresses.list.element.locality'] || [])[c.i]),
    confidence: (detail['confidence'] || [])[c.i],
    lon: (detail['bbox.xmin'] || [])[c.i],
    lat: (detail['bbox.ymin'] || [])[c.i]
  }));

  return {candidates, rows};
}

/* ------------------------------------------------------------------ *
 * The import
 * ------------------------------------------------------------------ */

/**
 * Read as many row groups as the budget allows and fold what they hold into
 * the database.
 *
 * Two budgets, and both matter. `deadline` is the round's, so the collector
 * gets on with crawling; `budgetBytes` is the bucket's, because this is
 * someone else's bandwidth and a round that decides to pull two gigabytes of
 * it is not a good guest. Progress is per row group, so a round that stops
 * halfway loses nothing: the next one starts at the next row group.
 */
async function importSlice(db, opts){
  opts = opts || {};
  const say = opts.log || (() => {});
  const deadline = opts.deadline || (Date.now() + 10 * 60 * 1000);
  const budgetBytes = (opts.budgetMB || DEFAULT_BUDGET_MB) * 1e6;
  const dryRun = !!opts.dryRun;

  const index = readJSON(INDEX_FILE, null);
  if(!index) return {error: 'no index yet — run node lib/overture.js --index'};

  const state = readJSON(STATE_FILE, {release: index.release, done: {}, perCountry: {}, added: 0, leads: 0});
  /* A new release invalidates the byte offsets in the old index, and with
   * them every record of what has been read. Carrying the done-list across a
   * release would silently skip whatever moved. */
  if(state.release !== index.release){
    say(`overture: release changed ${state.release} -> ${index.release}, starting the walk again`);
    state.release = index.release;
    state.done = {};
  }

  /* `only` narrows which row groups are visited, not what is kept: a row
   * group asked for because it covers Brazil is read for every wanted
   * country in it, because the bytes are already paid for. */
  const work = workList(index, state, db, opts.only);
  if(!work.length) return {done: true, groups: 0, added: 0, message: 'every row group has been read'};

  const leads = readJSON(LEADS_FILE, {});
  const pretend = new Set();
  const startBytes = bytesPulled;
  let groups = 0, seen = 0, added = 0, merged = 0, rejected = 0, withEmail = 0, leadCount = 0;
  const perCountry = {};

  /**
   * Fold one row group's findings into the database.
   *
   * Kept apart from the fetching so several row groups can be in flight at
   * once. Everything in here is synchronous from the first line to the last,
   * which is what makes the shared counters and the shared `db` safe without
   * a lock: the workers only ever interleave at an `await`, and there is not
   * one in this function.
   */
  function absorb(item, out){
    groups++;
    seen += out.rows.length;

    for(const row of out.rows){
      const made = toRecord(row, row.cc);
      if(!made) continue;
      if(made.reject){ rejected++; continue; }

      if(made.lead){
        const lk = 'n:' + row.cc + ':' + made.lead.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if(!leads[lk]){ leads[lk] = made.lead; leadCount++; }
        continue;
      }

      const rec = made;
      const k = keyFor(rec);

      /* A facility row may enrich a club that is already on file and may not
       * become one. `db[k]` is the whole test: same website host as a club
       * already collected means these are that club's courts. */
      if(rec.mergeOnly && !db[k] && !(dryRun && pretend.has(k))){ rejected++; continue; }
      delete rec.mergeOnly;

      perCountry[rec.cc] = (perCountry[rec.cc] || 0) + 1;
      if(opts.verbose)
        say(`  ${rec.cc} ${rec.name} | ${rec.sports.join('+')} | ${row.category || '-'} | ` +
            `${rec.email || '-'} | ${rec.website || '-'}`);

      if(db[k]){
        const cur = db[k];
        if(!cur.email && rec.email){ cur.email = rec.email; cur.crawled = true; withEmail++; }
        if(!cur.website && rec.website) cur.website = rec.website;
        if(!cur.social && rec.social) cur.social = rec.social;
        if(!cur.city && rec.city) cur.city = rec.city;
        cur.sports = Array.from(new Set((cur.sports || []).concat(rec.sports)));
        merged++;
      } else if(!dryRun){
        db[k] = rec;
        added++;
        if(rec.email) withEmail++;
      } else if(!pretend.has(k)){
        /* A dry run must not write to the database, so it counts against a
         * set of its own instead. Counting every row would overstate the
         * result badly: one Brasília club published three rows — its tennis
         * courts, its squash court and its beach tennis — which key to the
         * same website and become a single record with three sports. */
        pretend.add(k);
        added++;
        if(rec.email) withEmail++;
      } else {
        merged++;
      }
    }

    if(!dryRun){
      (state.done[item.fi] || (state.done[item.fi] = [])).push(item.gi);
    }
  }

  /**
   * Read several row groups at once.
   *
   * Sequentially this spends nearly all its time waiting on the network: the
   * measured first pass over Brazil moved 80.8 MB in 2m26s, which is a third
   * of what one connection to S3 will carry. The row groups are independent
   * of each other — separate byte ranges, separate decodes — so the only
   * thing that has to be shared is the pace.
   *
   * Every request still goes through the one gate in `httpGet`, so the
   * parallelism raises how much is in flight, not how often the bucket is
   * asked. Both budgets are checked before a worker picks up new work rather
   * than after, so a round stops when it said it would instead of overrunning
   * by however many row groups happen to be open.
   */
  let cursor = 0, spent = false;
  async function drain(){
    for(;;){
      if(spent || Date.now() > deadline || bytesPulled - startBytes > budgetBytes){ spent = true; return; }
      const item = work[cursor++];
      if(!item) return;

      let out;
      try{
        out = await readGroup(index.files[item.fi], item.group);
      }catch(e){
        say(`overture: row group ${item.fi}/${item.gi} failed — ${e.message}`);
        continue;
      }
      absorb(item, out);
    }
  }

  const lanes = Math.max(1, Math.min(opts.parallel || DEFAULT_PARALLEL, work.length));
  await Promise.all(Array.from({length: lanes}, drain));

  if(!dryRun){
    state.added = (state.added || 0) + added;
    state.leads = (state.leads || 0) + leadCount;
    for(const cc of Object.keys(perCountry))
      state.perCountry[cc] = (state.perCountry[cc] || 0) + perCountry[cc];
    state.lastRun = new Date().toISOString();
    writeJSON(STATE_FILE, state);
    if(leadCount) writeJSON(LEADS_FILE, leads);
  }

  const mb = ((bytesPulled - startBytes) / 1e6).toFixed(1);
  say(`overture: ${groups} row groups, ${mb} MB — ${seen} racket places -> +${added} new, ` +
      `${merged} merged, ${withEmail} with an email, ${leadCount} leads, ${rejected} dropped`);

  return {groups, seen, added, merged, rejected, withEmail, leads: leadCount,
          megabytes: Number(mb), perCountry, remaining: work.length - groups};
}

/** What the status page needs. */
function status(){
  const index = readJSON(INDEX_FILE, null);
  const state = readJSON(STATE_FILE, null);
  if(!index) return {indexed: false};
  const total = index.files.reduce((n, f) => n + f.groups.length, 0);
  let done = 0;
  for(const k of Object.keys((state && state.done) || {})) done += state.done[k].length;

  // How many of those row groups are ones this collector would ever read.
  let wanted = 0;
  for(const f of index.files) for(const g of f.groups) if(countriesIn(g).length) wanted++;

  return {
    indexed: true, release: index.release, built: index.built,
    files: index.files.length, rowGroups: total, wanted, done,
    added: (state && state.added) || 0, leads: (state && state.leads) || 0,
    perCountry: (state && state.perCountry) || {},
    lastRun: (state && state.lastRun) || null
  };
}

module.exports = { buildIndex, importSlice, status, toRecord, keyFor, BOXES,
                   SCAN_COLUMNS, DETAIL_COLUMNS, INDEX_FILE, STATE_FILE, LEADS_FILE };

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
if(require.main === module){
  const argv = process.argv.slice(2);
  const has = f => argv.includes(f);
  const num = (f, d) => { const a = argv.find(x => x.startsWith(f + '=')); return a ? parseFloat(a.split('=')[1]) : d; };
  const say = m => console.log(m);

  (async () => {
    if(has('--index')){ await buildIndex(say); return; }

    if(has('--status')){
      const s = status();
      if(!s.indexed){ console.log('overture: no index yet — run node lib/overture.js --index'); return; }
      console.log(`release ${s.release}, indexed ${s.built}`);
      console.log(`${s.done} of ${s.wanted} row groups read (${s.rowGroups} in the dataset, the rest are outside every wanted country)`);
      console.log(`${s.added} records added, ${s.leads} leads`);
      const per = Object.entries(s.perCountry).sort((a, b) => b[1] - a[1]);
      if(per.length) console.log('by country: ' + per.map(([cc, n]) => cc + ':' + n).join(' '));
      return;
    }

    if(has('--scan') || has('--import')){
      const dbFile = path.join(DATA_DIR, 'clubs.json');
      const db = readJSON(dbFile, {});
      const ccArg = argv.find(x => x.startsWith('--cc='));
      const r = await importSlice(db, {
        log: say,
        dryRun: has('--scan'),
        verbose: has('--verbose'),
        only: ccArg ? ccArg.split('=')[1].split(',') : null,
        parallel: num('--parallel', DEFAULT_PARALLEL),
        budgetMB: num('--mb', DEFAULT_BUDGET_MB),
        deadline: Date.now() + num('--minutes', 10) * 60 * 1000
      });
      if(r.error){ console.error(r.error); process.exit(1); }
      if(has('--import')){
        writeJSON(dbFile, db);
        console.log('saved ' + dbFile);
      }
      return;
    }

    console.log('usage: node lib/overture.js --index | --status');
    console.log('       node lib/overture.js --scan   [--cc=BR,MX] [--mb=N] [--minutes=N] [--parallel=N] [--verbose]');
    console.log('       node lib/overture.js --import [--cc=BR,MX] [--mb=N] [--minutes=N] [--parallel=N]');
  })().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
