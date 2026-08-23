# Racket club contact database

Tennis, padel and squash clubs across the eighty-three countries in the
brief, with the contact email each club publishes itself. Private clubs
only — council, community, university, school and government venues are
excluded on purpose.

**Live page: https://leoolmos.github.io/clubs-list/**

Search by name, contact or email; the three sport buttons stack, so picking
Tennis and Padel shows clubs offering both; Export CSV downloads whatever
is on screen. The page reads `clubs.json` from beside itself, and the
collector rewrites that file and pushes it once an hour.

Nothing here costs money. No API keys, no accounts, no billing, nothing to
sign up for — just ordinary HTTP requests to public pages, the same ones a
browser makes. Google Places and Maps are deliberately not used: those are
the paid ones.

## Running it

```bash
node daemon.js status        # what has been collected
node daemon.js once          # one round, then exit
node daemon.js serve         # round plus a live page on localhost:8787
```

Every round resumes where the last one stopped. Directory pagination is
bookmarked, crawled sites are marked, failures back off for a day and then
retry, and nothing is fetched twice.

### Continuously, in the background

```bash
powershell -ExecutionPolicy Bypass -File start-collector.ps1
powershell -ExecutionPolicy Bypass -File start-collector.ps1 -Status
powershell -ExecutionPolicy Bypass -File start-collector.ps1 -Stop
```

One detached process working rounds back to back, pushing after each. It
survives closing the window; it stops at logout or reboot, so start it
again then. Only one may run at a time — two would fight over the same
files and the same git branch.

Log: `data/daemon.log`. Follow it with
`Get-Content data\daemon.log -Wait -Tail 5`.

`install-windows.ps1` still exists for an hourly Scheduled Task instead,
but back-to-back rounds collect far more: an hourly job sat idle for most
of the hour while hundreds of sites were still queued for an email.

```bash
node publish.js status       # where it publishes, and when it last did
node publish.js              # push now
node publish.js off          # stop pushing; collection carries on
```

## Where the clubs come from

**Federation and association directories** — `seeds.txt`. The best source
by a distance where one exists: Spain's RFET prints each club's email on
its own page, and 45 pages of it produced 366 clubs of which 330 had an
email. Add a page after checking it:

```bash
node check.js <url> [COUNTRY] --detail
node harvest.js <url> <COUNTRY>      # add it and work it now
```

`check.js` fetches the page the way the daemon does and prints how many
club links and emails are really in the HTML. A directory that looks rich
in a browser is often empty to a crawler, because the list is drawn by
JavaScript. Checks are recorded in `data/checked.log`, so nothing is
investigated twice, and `seeds.txt` keeps a list of what was rejected and
why.

**The LTA venue register** — `lib/lta.js`. Britain's federation lists 994
venues and prints each one's own email and website on its page, which makes
it the richest British source there is — the same shape as Spain's RFET.

```bash
node lib/lta.js --status         where the walk has got to
node lib/lta.js --pages=3        read three pages and print what they hold
```

Getting at it needed care, because the two obvious routes are closed. The
sitemap carries 5,900 pages and not one venue among them. And the map
search, the one the site actually uses, is disallowed:
`Disallow: /*?*latitude*longitude*`. It works and it is not ours to use.

What is allowed is the plain alphabetical listing —
`/play/find-a-tennis-court?fltr=y&sort=nameAsc&p=2` — which paginates ten to
a page and ends at p=100.

The register lists places with a court, not clubs: scout huts, park courts
and a venue whose published address is `nonmember@nonmember.com` are all on
it. Where the name does not say what it is, the venue's own website decides,
by the same test the prospector puts a stranger's site through. Seventy
venues read gave twenty clubs, the All England Lawn Tennis Club among them.

**OpenStreetMap** — `lib/osm.js`. Federation directories only exist where
there is a federation with a crawlable website, which leaves most of the
eighty-three countries with nothing: there is no Tuvalu tennis directory.
OSM covers all of them, through the public Overpass endpoint — read-only,
no key, no account.

```bash
node lib/osm.js --all --parallel=6   # every country, several at a time
node lib/osm.js --status             # what has been imported
node lib/osm.js ES PT BR             # named countries
```

**Overpass is the bottleneck, and more parallelism does not fix it.** The
mirrors publish their limits at `/api/status` — measured 2026-08-08,
`overpass-api.de` allows two queries at a time per IP, while
`kumi.systems` and `private.coffee` declare no limit. So six in flight
spreads across all three without queueing. Beyond that the extra workers
collect refusals.

They also have bad afternoons. A country-wide query that returned in
seconds in the morning came back `504`, or `200` with a "Query timed out"
remark, a few hours later — for Malta, which has six racket venues in the
whole database. When that happens the importer gives up after a run of
consecutive failures and hands the rest of the round to the crawler, which
does not depend on Overpass and is where the emails actually come from.
The countries stay unimported and are retried next round.

It keeps places that publish a website or an email. Named clubs with
neither go to `data/osm-leads.json` rather than being discarded, so they
are not rediscovered every run.

**Prospecting** — `lib/prospect.js`. The two engines above between them
left sixty-two of the eighty-three countries at zero, and not because they
failed there. Every one of the 64 directory seeds is Spain, Ireland or
Britain, and the club search only ever looks up a name OpenStreetMap has
already supplied — which in those countries it has not. Kenya returned 18
places and 13 were dropped as public; Malawi returned 4. No name, no query,
no clubs, for as long as it runs.

So this asks for a country's clubs directly, in the country's own language:
`club de tenis Panamá contacto`, `clube de ténis Angola contacto`. Nothing
is trusted from the results themselves — a query with no club name in it
cannot be checked against one afterwards — so each candidate is read first
and has to name itself like a club, show a racket sport on its own page,
pass the same private-club rules as every other record, and tie itself to
the country asked for. It stops at the website; the crawl below is what
turns that into an address.

The countries with the fewest clubs go first. What it turned down on the
first run is as much the point as what it kept: a global padel directory
that ranked for El Salvador, a squash magazine that would have been
published as the only club in Equatorial Guinea, and a booking platform
titled "Court Booking System for South Africa" that ranked for Kenya.

**Finding new directories** — `discover.js`. Seeds are the bottleneck and
always were, and until now the walk that fixes it only ran when somebody
typed it by hand. The daemon runs it when every seed is exhausted, which is
the state that used to simply end the round early.

**The site crawl.** Anything with a website but no email yet gets the whole
site read, within reason: the homepage and its footer; every page the
homepage links to that a contact word describes in any of the three
languages — contact pages first, then about, members and where-we-are,
then the legal small print, which prints an address on sites with no
contact page; the pages the sitemap lists under the same words; the
guessed paths in the club's own language (`/contato` and `/fale-conosco` for
Brazil, `/contactos` for Portugal, `/contacto` and `/contactanos` for
Spanish, `/contact-us` for English); and then the rest of the site's own
pages, up to thirty in all, each page read adding the contact-word links it
carries, so a contact page reachable only from "About" is reached. A site
that only answers at the other scheme or without `www` is tried both ways
before it is called unreachable. The vocabulary is in `lib/contact.js`,
shared with the prospector. Cloudflare-obfuscated, entity-encoded,
`'info' + '@' + 'club.com'` and "info [at] club [dot] com" style addresses
are decoded; a site with a contact form and no address is noted as exactly
that. The page that carried the address also names the club's city, which
is what the coverage tab counts by. When the crawl changes (`CRAWL_EPOCH`
in daemon.js), every site settled as "publishes no address" is read once
more.

## What counts as collected

A club appears on the page only with all four required fields: name, at
least one sport, an email, and a language. Anything short of that stays in
the working store and out of `clubs.json`.

Language comes from the country, as asked. Equatorial Guinea is in both the
Spanish and Portuguese lists in the brief; it is recorded as Spanish and
appears once.

## Layout

```
index.html          the page (this is what GitHub Pages serves)
clubs.json          published extract — the only data file committed
daemon.js           rounds: crawl, harvest, one OSM country, publish
check.js            is this listing page worth seeding?
discover.js         walk a directory tree looking for club listings
harvest.js          add one directory and work it immediately
publish.js          commit clubs.json and push
install-windows.ps1 hourly Scheduled Task
seeds.txt           directories, with notes on what was rejected and why
lib/lta.js          the LTA's 994 British venues, walked once
lib/prospect.js     search a country's clubs out from nothing
lib/countries.js    the eighty-three countries, languages, domain to country
lib/classify.js     sports, private-club rules, email extraction
lib/http.js         character sets, robots.txt, per-host spacing
lib/osm.js          OpenStreetMap importer
data/               working store, queue, logs — not committed
```

## Things worth knowing before changing it

These are all mistakes the code used to make, found by running it and
checking the output. The comments in place say the same thing; this is the
short version.

**A club's website is not the first outbound link on its directory page.**
That link is usually the federation's sponsor. Worse, records are keyed by
website host, so two clubs sharing a sponsor merged into one record and the
other was lost — which is exactly what happened to a Basque tennis club
that came out with `iberdrola.es` as its website. An outbound link now has
to look like it belongs to the club, and an address on the club's own
domain is preferred over any link on the page.

**Directory-wide emails appear on every club's page.** The federation
office, the regional development officer, the webmaster: they sit in the
template. Taking one would have given all 180 clubs in an Irish region the
same address, and since the export deduplicates on email they would have
collapsed to a single row. Addresses on the directory's own domain, and any
address that also appears on the listing page, are excluded. As a backstop,
an address claimed by more than five clubs is dropped and logged.

**Character sets are declared, not assumed.** Plenty of federation sites
are windows-1252. Forcing utf8 stored `PEÑA VITORIANA` as `PE?A VITORIANA`,
and nothing downstream can repair that.

**A missing Content-Type header is not a reason to discard a page.** Curlie
sends none at all; requiring one threw away every page on the site and the
walk reported them as dead.

**Overpass mirrors disagree.** They carry different snapshots — the same
Malta query returned 2, 4 and 6 places from three of them — and a
too-heavy query comes back as HTTP 200 with partial results and a `remark`
field. Accepting that silently under-collects a country and then marks it
done. Partial responses are now refused, and re-imports top a country up.

**One seed per round is far too slow.** A federation that lists one
province per URL is fifty-two separate unpaginated seeds; Spain alone would
have taken fifty-two hours. Rounds now work seeds until the page budget is
spent.

**`BUDGET_MINUTES` is minutes, not money.** How long a round is allowed to
work before it stops and waits for the next hour.

## Tuning

```
TICK_MINUTES=60  BUDGET_MINUTES=20  CONCURRENCY=8  HOST_DELAY_MS=2000
PAGES_PER_TICK=25  OSM=off  LTA_MINUTES=6  LTA=off
CRAWL_MINUTES=12  CONTACT_PAGES=30  SITE_MS=150000  PROSPECT_MINUTES=14  PLACE_MINUTES=3
VET_PARALLEL=4  SEARCH_GAP_MS=2500  SEARCH_RETRY_WAIT_MS=45000  SEARCH_COOLDOWN_MS=180000
```
