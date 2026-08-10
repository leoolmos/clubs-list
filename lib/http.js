'use strict';
/**
 * The fetching layer: character sets, robots.txt, per-host spacing, links.
 *
 * Shared so the daemon and the one-shot harvester behave identically. They
 * used to have a copy each, and the copies disagreed — the harvester was
 * still forcing utf8 on pages that declare windows-1252, which quietly
 * corrupted every accented club name it collected.
 */

const UA = 'RacketClubResearch/1.0 (club directory research; contact: set-your-email@example.com)';

const MAX_BYTES = 4_000_000;

const lastHit     = new Map();
const robotsCache = new Map();

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* ------------------------------------------------------------------ *
 * Character sets
 * ------------------------------------------------------------------ */
function decodeBody(buf, contentType){
  let charset = (String(contentType||'').match(/charset=["']?([\w\-]+)/i)||[])[1];

  if(!charset){
    // No charset header, so the declaration is inside the document. It is
    // ASCII either way, so latin1 reads the first block safely.
    const head = Buffer.from(buf.slice(0, 4096)).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w\-]+)/i)||[])[1]
           || (head.match(/content=["'][^"']*charset=([\w\-]+)/i)||[])[1];
  }

  charset = String(charset||'utf-8').toLowerCase().trim();
  // Pages labelled iso-8859-1 are windows-1252 in practice, and the browsers
  // all treat them that way. Following the label loses the curly quotes.
  if(charset === 'iso-8859-1' || charset === 'latin1') charset = 'windows-1252';

  try{ return new TextDecoder(charset, {fatal:false}).decode(buf); }
  catch(e){ return Buffer.from(buf).toString('utf8'); }
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */
async function rawFetch(url, ms){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), ms||15000);
  try{
    const r = await fetch(url, {
      headers:{'User-Agent':UA, 'Accept':'text/html,application/xhtml+xml,*/*'},
      redirect:'follow', signal:ctl.signal
    });
    if(!r.ok) return null;

    const ct = r.headers.get('content-type')||'';
    // A wrong content-type is a reason to skip; a missing one is not.
    // Curlie serves its whole directory with no Content-Type header, so
    // requiring the header threw away every page on the site — the walk
    // recorded 122 of 220 pages as dead and moved on.
    if(ct && !/text\/html|application\/xhtml|text\/plain|^\s*$/i.test(ct)) return null;

    const buf = await r.arrayBuffer();
    if(buf.byteLength > MAX_BYTES) return null;

    // An empty 200 is how some sites turn a crawler away without saying so.
    // Curlie starts doing it after a couple of hundred requests. Treated as
    // a normal miss, it reads as "this page has no clubs on it".
    if(buf.byteLength === 0) return null;

    const text = decodeBody(buf, ct);
    if(!ct && !/<\s*(!doctype|html|head|body|a\b|div)/i.test(text.slice(0, 2000))) return null;
    return text;
  }catch(e){ return null; }
  finally{ clearTimeout(t); }
}

async function politeWait(host, delayMs){
  const prev = lastHit.get(host) || 0;
  const wait = (delayMs||2000) - (Date.now() - prev);
  if(wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

/* robots.txt, for the wildcard user-agent group only. Deliberately strict:
 * a disallowed prefix means the page is not fetched at all. */
async function robotsAllow(origin, pathname, timeoutMs){
  if(!robotsCache.has(origin)){
    const txt = await rawFetch(origin+'/robots.txt', timeoutMs || 6000);
    const rules = [];
    if(txt){
      let applies = false;
      for(const line of txt.split(/\r?\n/)){
        const l = line.trim();
        if(/^user-agent:/i.test(l))      applies = /\*\s*$/.test(l);
        else if(applies && /^disallow:/i.test(l)){
          const p = l.slice(l.indexOf(':')+1).trim();
          if(p) rules.push(p);
        }
      }
    }
    robotsCache.set(origin, rules);
  }
  return !robotsCache.get(origin).some(r => pathname.startsWith(r));
}

/**
 * Is this a challenge page rather than the site?
 *
 * Found by hand-checking four English tennis clubs the crawler had written
 * off as publishing no address. Three returned 168 bytes:
 *
 *   <html><head><meta http-equiv="refresh"
 *     content="0;/.well-known/sgcaptcha/?r=%2F..."></head></html>
 *
 * A SiteGround captcha, served with HTTP 202, and a browser user-agent gets
 * the same. Read as an ordinary page it looks like a club with nothing on
 * its site — and since "publishes no address" was treated as settled, each
 * one was struck off for good after a single look.
 */
function isChallenge(html){
  if(!html) return false;
  if(html.length < 900 && /http-equiv=["']refresh/i.test(html)) return true;
  return /sgcaptcha|\/cdn-cgi\/challenge|cf[-_]chl|captcha-delivery|__cf_chl|jschl_vc|incapsula|distil_r_blocked|are you a human|enable javascript to continue/i
    .test(html);
}

/* A page whose whole body is a meta refresh is a redirect, and the browser
 * would follow it. Returns the target, or '' when there is nothing to
 * follow — including when the target is a challenge, which is not somewhere
 * worth going. */
function metaRefreshTarget(html, base){
  const m = String(html||'').match(/http-equiv=["']refresh["'][^>]*content=["']\s*\d+\s*;\s*(?:url=)?([^"'>]+)/i);
  if(!m) return '';
  const target = m[1].trim();
  if(/captcha|challenge|\.well-known/i.test(target)) return '';
  try{ return new URL(target, base).toString(); }catch(e){ return ''; }
}

/** Fetch a page, honouring robots.txt and the per-host delay. */
async function getPage(url, delayMs, timeoutMs){
  let u; try{ u = new URL(url); }catch(e){ return null; }
  if(!/^https?:$/.test(u.protocol)) return null;
  // robots.txt gets its own, shorter budget: a site whose robots file will
  // not load should not eat the whole page budget before we even ask.
  if(!(await robotsAllow(u.origin, u.pathname, timeoutMs ? Math.min(timeoutMs, 4000) : 6000))) return null;
  await politeWait(u.hostname, delayMs);

  const html = await rawFetch(url, timeoutMs);
  if(!html) return null;

  // A body that is nothing but a meta refresh is a redirect the browser
  // would follow, so follow it once.
  const next = metaRefreshTarget(html, url);
  if(next && html.length < 2000){
    await politeWait(new URL(next).hostname, delayMs);
    const second = await rawFetch(next, timeoutMs);
    if(second) return second;
  }
  return html;
}

/* ------------------------------------------------------------------ *
 * Link parsing
 * ------------------------------------------------------------------ */
function links(html, base){
  const out = [];
  for(const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    if(/^(#|javascript:|mailto:|tel:)/i.test(m[1])) continue;
    let abs; try{ abs = new URL(m[1], base).toString(); }catch(e){ continue; }
    const text = m[2].replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ')
                     .replace(/&amp;/gi,'&').replace(/&[a-z]+;/gi,' ')
                     .replace(/\s+/g,' ').trim();
    out.push({url:abs, text});
  }
  return out;
}

function hostOf(u){
  try{ return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); }catch(e){ return ''; }
}

module.exports = { UA, sleep, decodeBody, rawFetch, robotsAllow, politeWait, getPage, links, hostOf };
