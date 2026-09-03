'use strict';
/**
 * A Parquet reader, cut down to exactly what Overture writes
 * =========================================================================
 * The Overture places dataset is 10.5 GB of Parquet spread over sixteen
 * files, and the only ways anyone documents to read it are DuckDB and
 * Python. Neither belongs in this repository: it has no package.json, no
 * node_modules and no build step, and it stays that way because the whole
 * point is that a fresh clone runs.
 *
 * So this reads Parquet directly. Not all of Parquet — that would be a
 * project of its own — only the one shape Overture actually publishes,
 * measured against the August 2026 release:
 *
 *   compression         ZSTD                (Node's zlib does this natively)
 *   pages               DATA_PAGE v1        header says version 0
 *   values              RLE_DICTIONARY      every column has a dictionary
 *   levels              RLE                 def and rep both
 *   physical types      BYTE_ARRAY, DOUBLE
 *   lists               the standard three-level LIST annotation
 *
 * Anything outside that throws by name. That is deliberate. A reader that
 * guesses at an encoding it does not know returns plausible rubbish, and
 * rubbish that looks like a club name would be published as a club — so it
 * has to stop instead, loudly, when the next release changes something.
 *
 * Everything is read through a `reader` function — `(from, to) => Buffer` —
 * so the same code works over an HTTP range request and over a local file.
 * Nothing is ever held whole: the largest thing this allocates is one
 * decompressed column chunk, a few hundred kilobytes.
 * =========================================================================
 */

const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * Thrift compact protocol
 * ------------------------------------------------------------------ *
 * Parquet's metadata — the footer and every page header — is Thrift in the
 * compact encoding. It is a small format: a struct is a run of fields, each
 * introduced by one byte holding the type in the low nibble and the jump
 * from the previous field id in the high nibble, terminated by a zero byte.
 *
 * Field ids are not decoded into names here. The struct comes back as a
 * plain object keyed by number and the callers say what they mean — `m[9]`
 * with a comment beats a hand-written schema for thirty structs of which we
 * use eight fields.
 *
 * Integers are zigzag varints, and they can exceed 2^53: a column chunk
 * offset in a 700 MB file does not, but the format allows it, so the varint
 * is accumulated in BigInt and narrowed once.
 */
class Thrift {
  constructor(buf, pos){ this.b = buf; this.p = pos || 0; }

  u8(){ return this.b[this.p++]; }

  varint(){
    let shift = 0, out = 0n;
    for(;;){
      const c = this.b[this.p++];
      if(c === undefined) throw new Error('parquet: metadata ended mid-varint');
      out |= BigInt(c & 0x7f) << BigInt(shift);
      if(!(c & 0x80)) break;
      shift += 7;
    }
    return out;
  }

  int(){ const v = this.varint(); return Number((v >> 1n) ^ -(v & 1n)); }

  bin(){
    const n = Number(this.varint());
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }

  value(type){
    switch(type){
      case 1:  return true;
      case 2:  return false;
      case 3:  return this.b.readInt8(this.p++);
      case 4: case 5: case 6: return this.int();
      case 7:  { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
      case 8:  return this.bin();
      case 9: case 10: return this.list();
      case 11: return this.map();
      case 12: return this.struct();
      default: throw new Error('parquet: unknown thrift type ' + type);
    }
  }

  /* A short list packs its length into the header nibble; fifteen or more
   * spills into a varint after it. */
  list(){
    const h = this.u8();
    let n = h >> 4;
    const t = h & 0x0f;
    if(n === 15) n = Number(this.varint());
    const out = new Array(n);
    for(let i = 0; i < n; i++) out[i] = this.value(t);
    return out;
  }

  map(){
    const n = Number(this.varint());
    if(!n) return [];
    const kv = this.u8();
    const kt = kv >> 4, vt = kv & 0x0f;
    const out = new Array(n);
    for(let i = 0; i < n; i++) out[i] = [this.value(kt), this.value(vt)];
    return out;
  }

  struct(){
    const out = {};
    let id = 0;
    for(;;){
      const h = this.u8();
      if(h === 0 || h === undefined) return out;
      const t = h & 0x0f, delta = h >> 4;
      id = delta ? id + delta : this.int();
      out[id] = this.value(t);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The footer
 * ------------------------------------------------------------------ */

/**
 * Read a file's metadata.
 *
 * The last eight bytes are the footer length and the magic `PAR1`. Checking
 * the magic is not ceremony: an S3 range request that is served an error
 * document, or a truncated download, both arrive as a Buffer of the right
 * shape, and without the check the Thrift parser walks off into it and
 * throws something unhelpful three frames down.
 */
async function readFooter(reader, fileSize){
  const tail = await reader(fileSize - 8, fileSize - 1);
  if(tail.length !== 8 || tail.subarray(4).toString('latin1') !== 'PAR1')
    throw new Error('parquet: not a parquet file (no PAR1 at the end)');

  const len = tail.readUInt32LE(0);
  if(len <= 0 || len > fileSize - 8) throw new Error('parquet: footer length ' + len + ' makes no sense');

  const buf = await reader(fileSize - 8 - len, fileSize - 9);
  const md = new Thrift(buf).struct();

  // FileMetaData: 1 version, 2 schema, 3 num_rows, 4 row_groups, 6 created_by
  return {
    version:   md[1],
    schema:    parseSchema(md[2] || []),
    numRows:   md[3],
    rowGroups: (md[4] || []).map(parseRowGroup),
    createdBy: md[6] ? String(md[6]) : ''
  };
}

/**
 * Flatten the schema into one entry per leaf column, carrying the two
 * numbers that decide how its values are read back.
 *
 * `maxDef` and `maxRep` are the whole of Parquet's nesting model. A leaf is
 * stored as a flat run of values plus, for each slot, a definition level
 * saying how deep the value is really defined and a repetition level saying
 * where a new row starts. `websites` is the standard three-level list —
 * optional group `websites`, repeated group `list`, optional `element` — so
 * maxDef is 3 and maxRep is 1, and a slot with def 3 is a URL while def 1 is
 * an empty list and def 0 is no list at all. `names.primary` is two optional
 * groups deep and never repeats, so maxDef 2 and maxRep 0.
 *
 * Getting these wrong does not throw. It shifts every value by one row,
 * which is the single most dangerous bug this file can have — a club would
 * get its neighbour's email — so they are computed from the file's own
 * schema rather than hard-coded from the column paths.
 */
function parseSchema(elements){
  const leaves = [];
  let i = 0;

  function walk(path, def, rep){
    // SchemaElement: 1 type, 2 type_length, 3 repetition_type, 4 name,
    //                5 num_children, 6 converted_type
    const e = elements[i++];
    if(!e) return;
    const name = String(e[4] || '');
    const repetition = e[3];              // 0 REQUIRED, 1 OPTIONAL, 2 REPEATED
    const here = path.concat(name);

    const d = def + (repetition === 1 || repetition === 2 ? 1 : 0);
    const r = rep + (repetition === 2 ? 1 : 0);

    if(e[5]){                             // a group: recurse over its children
      for(let c = 0; c < e[5]; c++) walk(here, d, r);
    } else {
      leaves.push({path: here.join('.'), type: e[1], maxDef: d, maxRep: r});
    }
  }

  // The root element names the file, not a column, so its name is dropped
  // and its children are walked at depth zero.
  const root = elements[0];
  i = 1;
  for(let c = 0; c < (root && root[5] || 0); c++) walk([], 0, 0);

  const byPath = new Map(leaves.map(l => [l.path, l]));
  return {leaves, byPath};
}

function parseRowGroup(rg){
  // RowGroup: 1 columns, 2 total_byte_size, 3 num_rows
  const columns = new Map();
  for(const c of (rg[1] || [])){
    // ColumnChunk: 3 meta_data
    // ColumnMetaData: 1 type, 2 encodings, 3 path_in_schema, 4 codec,
    //                 5 num_values, 6 total_uncompressed_size,
    //                 7 total_compressed_size, 9 data_page_offset,
    //                 11 dictionary_page_offset, 12 statistics
    const m = c[3];
    if(!m) continue;
    const path = (m[3] || []).map(String).join('.');

    /* Where the chunk starts. The dictionary page comes first when there is
     * one, and `data_page_offset` points past it — so starting at the data
     * page offset silently skips the dictionary and every value decodes to
     * undefined. Some writers also emit a dictionary_page_offset of 0
     * meaning "none", which is why this compares rather than trusts. */
    const dict = m[11];
    const data = m[9];
    const start = (dict != null && dict > 0 && dict < data) ? dict : data;

    columns.set(path, {
      path, type: m[1], codec: m[4], encodings: m[2] || [],
      numValues: m[5], compressedSize: m[7],
      start, dataPageOffset: data, dictPageOffset: dict,
      statistics: m[12] || null
    });
  }
  return {numRows: rg[3], byteSize: rg[2], columns};
}

/**
 * The min and max a row group holds for a DOUBLE column, from the statistics
 * the writer left in the footer — which is what makes reading one country
 * out of a global file affordable at all.
 *
 * Statistics carries two generations of the same fields: 1/2 are the
 * deprecated `max`/`min`, 5/6 the current `max_value`/`min_value`. Reading
 * 5 as the minimum because it comes first in the struct is an easy mistake
 * and an invisible one — the bounds come back inverted, every row group
 * looks like it misses the country, and the importer reports the country as
 * empty rather than failing.
 */
function doubleStats(col){
  const s = col && col.statistics;
  if(!s) return null;
  const max = s[5] !== undefined ? s[5] : s[1];
  const min = s[6] !== undefined ? s[6] : s[2];
  if(!Buffer.isBuffer(min) || !Buffer.isBuffer(max)) return null;
  const num = b => b.length === 8 ? b.readDoubleLE(0) : b.length === 4 ? b.readFloatLE(0) : NaN;
  const lo = num(min), hi = num(max);
  return Number.isFinite(lo) && Number.isFinite(hi) ? {min: lo, max: hi} : null;
}

/* ------------------------------------------------------------------ *
 * Decompression
 * ------------------------------------------------------------------ */
const CODECS = {0: 'uncompressed', 1: 'snappy', 2: 'gzip', 3: 'lzo', 4: 'brotli', 5: 'lz4', 6: 'zstd', 7: 'lz4_raw'};

/* Node grew zstd in 22.15 and 23.8. The collector is documented as needing
 * Node 26 for an unrelated undici bug, so this is always there in practice —
 * but a clear message beats `zlib.zstdDecompressSync is not a function`. */
function decompress(buf, codec, expectedSize){
  if(codec === 0) return buf;
  if(codec === 2) return zlib.gunzipSync(buf);
  if(codec === 6){
    if(typeof zlib.zstdDecompressSync !== 'function')
      throw new Error('parquet: this Node has no zstd — needs Node 22.15+ or 23.8+');
    return zlib.zstdDecompressSync(buf, {maxOutputLength: Math.max(expectedSize * 2, 1 << 20)});
  }
  throw new Error('parquet: unsupported compression "' + (CODECS[codec] || codec) + '"');
}

/* ------------------------------------------------------------------ *
 * The RLE / bit-packed hybrid
 * ------------------------------------------------------------------ *
 * One encoding does three jobs in Parquet: definition levels, repetition
 * levels, and — as RLE_DICTIONARY — the dictionary indices that are the
 * values themselves. It alternates two kinds of run, chosen per run by the
 * low bit of a varint header:
 *
 *   header & 1 == 1   bit-packed: (header >> 1) groups of eight values,
 *                     each `width` bits, packed from the least significant
 *                     bit of each byte upwards and running across byte
 *                     boundaries
 *   header & 1 == 0   run-length: (header >> 1) copies of one value, stored
 *                     little-endian in ceil(width/8) bytes
 *
 * A width of zero is legal and means every value is zero — no bytes follow
 * at all. That is not a curiosity: it is exactly what a column with no nulls
 * writes for its definition levels, so a decoder that divides by the width
 * or reads a byte anyway loses the entire column.
 */
function readHybrid(buf, pos, width, count, out){
  let n = 0;
  const bytes = (width + 7) >> 3;

  while(n < count){
    if(width === 0){ out[n++] = 0; continue; }

    // The run header is an unsigned LEB128 varint, not a zigzag one.
    let shift = 0, header = 0;
    for(;;){
      const c = buf[pos++];
      if(c === undefined) throw new Error('parquet: hybrid run ran off the end of the page');
      header |= (c & 0x7f) << shift;
      if(!(c & 0x80)) break;
      shift += 7;
    }

    if(header & 1){
      const groups = header >> 1;
      let bitPos = 0;
      const base = pos;
      for(let g = 0; g < groups && n < count; g++){
        for(let k = 0; k < 8; k++){
          // Assemble `width` bits starting at bitPos, low bit first.
          let v = 0;
          for(let bit = 0; bit < width; bit++){
            const at = bitPos + bit;
            v |= ((buf[base + (at >> 3)] >> (at & 7)) & 1) << bit;
          }
          bitPos += width;
          if(n < count) out[n++] = v;
        }
      }
      pos = base + groups * width;      // eight values of `width` bits per group
    } else {
      const run = header >> 1;
      let v = 0;
      for(let b = 0; b < bytes; b++) v |= buf[pos + b] << (b * 8);
      pos += bytes;
      const stop = Math.min(count, n + run);
      while(n < stop) out[n++] = v;
    }
  }
  return pos;
}

/* The bit width Parquet uses for a level: just enough to hold maxLevel. */
function bitWidth(max){
  let w = 0;
  while(max >> w) w++;
  return w;
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

/** PLAIN: BYTE_ARRAY is a four-byte little-endian length then the bytes. */
function plainByteArrays(buf, count){
  const out = new Array(count);
  let p = 0;
  for(let i = 0; i < count; i++){
    const n = buf.readUInt32LE(p); p += 4;
    out[i] = buf.toString('utf8', p, p + n);
    p += n;
  }
  return out;
}

function plainDoubles(buf, count){
  const out = new Float64Array(count);
  for(let i = 0; i < count; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}

/**
 * Decode one column chunk into per-row values.
 *
 * Returns an array with one entry per row in the row group: a string (or
 * number) for a flat column, an array for a list column, and null where the
 * value is absent. `bytes` is the whole chunk, already fetched.
 */
function decodeColumn(bytes, col, leaf){
  const {maxDef, maxRep} = leaf;
  const rows = [];
  let dictionary = null;
  let cursor = 0;
  let current = null;               // the list being filled, for maxRep > 0

  while(cursor < bytes.length){
    const th = new Thrift(bytes, cursor);
    const h = th.struct();
    // PageHeader: 1 type, 2 uncompressed_page_size, 3 compressed_page_size,
    //             5 data_page_header, 7 dictionary_page_header, 8 v2 header
    const headerEnd = th.p;
    const compSize = h[3], uncompSize = h[2];
    if(!compSize) throw new Error('parquet: page header with no compressed size');

    const raw = bytes.subarray(headerEnd, headerEnd + compSize);
    cursor = headerEnd + compSize;

    if(h[1] === 2){                                    // DICTIONARY_PAGE
      const d = h[7] || {};
      // DictionaryPageHeader: 1 num_values, 2 encoding
      if(d[2] !== undefined && d[2] !== 0 && d[2] !== 2)
        throw new Error('parquet: dictionary page encoding ' + d[2] + ', expected PLAIN');
      const page = decompress(raw, col.codec, uncompSize);
      dictionary = col.type === 6 ? plainByteArrays(page, d[1]) : plainDoubles(page, d[1]);
      continue;
    }

    if(h[1] === 3) throw new Error('parquet: DATA_PAGE_V2 — this reader only handles v1');
    if(h[1] !== 0) continue;                           // index pages and anything else

    const dp = h[5] || {};
    // DataPageHeader: 1 num_values, 2 encoding, 3 def_level_encoding, 4 rep_level_encoding
    const count = dp[1];
    const encoding = dp[2];
    const page = decompress(raw, col.codec, uncompSize);
    let p = 0;

    /* Levels come first, repetition before definition, each as a four-byte
     * length then a hybrid run. A column that never repeats writes no
     * repetition levels at all — not a zero-length block, nothing — so the
     * length must not be read when maxRep is 0. */
    let repLevels = null, defLevels = null;

    if(maxRep > 0){
      if(dp[4] !== 3) throw new Error('parquet: repetition levels encoded as ' + dp[4] + ', expected RLE');
      const len = page.readUInt32LE(p); p += 4;
      repLevels = new Int32Array(count);
      readHybrid(page, p, bitWidth(maxRep), count, repLevels);
      p += len;
    }
    if(maxDef > 0){
      if(dp[3] !== 3) throw new Error('parquet: definition levels encoded as ' + dp[3] + ', expected RLE');
      const len = page.readUInt32LE(p); p += 4;
      defLevels = new Int32Array(count);
      readHybrid(page, p, bitWidth(maxDef), count, defLevels);
      p += len;
    }

    /* How many real values sit in this page: one per slot that is defined
     * all the way down. Nulls and empty lists take a level but no value. */
    let present = count;
    if(defLevels){
      present = 0;
      for(let i = 0; i < count; i++) if(defLevels[i] === maxDef) present++;
    }

    let values;
    if(encoding === 8 || encoding === 7){              // RLE_DICTIONARY (7 is its old id)
      if(!dictionary) throw new Error('parquet: dictionary-encoded page with no dictionary page before it');
      const width = page[p]; p += 1;
      const idx = new Int32Array(present);
      readHybrid(page, p, width, present, idx);
      values = new Array(present);
      for(let i = 0; i < present; i++) values[i] = dictionary[idx[i]];
    } else if(encoding === 0){                         // PLAIN
      const body = page.subarray(p);
      values = col.type === 6 ? plainByteArrays(body, present) : plainDoubles(body, present);
    } else {
      throw new Error('parquet: value encoding ' + encoding + ' is not one this reader knows');
    }

    /* Walk the levels back into rows. For a flat column every slot is a row.
     * For a list, a repetition level of 0 opens a new row and anything
     * higher continues the one before it — which is why a page boundary is
     * safe: Parquet never splits a row across pages, so the first slot of
     * every page has rep 0. */
    let v = 0;
    for(let i = 0; i < count; i++){
      const def = defLevels ? defLevels[i] : maxDef;
      const rep = repLevels ? repLevels[i] : 0;

      if(maxRep === 0){
        rows.push(def === maxDef ? values[v++] : null);
        continue;
      }
      if(rep === 0){ current = null; rows.push(null); }
      if(def === maxDef){
        if(!current){ current = []; rows[rows.length - 1] = current; }
        current.push(values[v++]);
      }
    }
  }

  return rows;
}

/**
 * Fetch and decode several columns of one row group.
 *
 * The columns are fetched one at a time on purpose. Each is a few hundred
 * kilobytes and they are read from someone else's donated bandwidth; eight
 * parallel range requests per row group, across a few hundred row groups,
 * is the kind of traffic that gets an address blocked from a public bucket.
 */
async function readColumns(reader, rowGroup, schema, paths){
  const out = {};
  for(const path of paths){
    const col = rowGroup.columns.get(path);
    const leaf = schema.byPath.get(path);
    if(!col || !leaf){ out[path] = null; continue; }
    const bytes = await reader(col.start, col.start + col.compressedSize - 1);
    out[path] = decodeColumn(bytes, col, leaf);
  }
  return out;
}

/** How many bytes reading these columns of this row group would cost. */
function costOf(rowGroup, paths){
  let n = 0;
  for(const p of paths){
    const c = rowGroup.columns.get(p);
    if(c) n += c.compressedSize;
  }
  return n;
}

module.exports = { readFooter, readColumns, decodeColumn, doubleStats, costOf, Thrift };
