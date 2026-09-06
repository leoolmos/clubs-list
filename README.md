# Racket club contact database

Tennis, padel, squash and pickleball clubs across the eighty-three countries
in the brief, with the contact email each club publishes itself. Private
clubs only — council, community, university, school and government venues are
excluded on purpose.

Four sports and no others. Table tennis, beach tennis, racquetball, badminton
and frontón all say one of the four in one language or another, and all of
them used to be collected: "Tenis de Mesa Lidia Calderón" was filed as a
Colombian tennis club. A place whose only racket sport is one of those is
dropped now, while a club that plays one of the four *and* something else —
"Tênis e Tênis de Mesa" is a common pairing in Brazil — is kept as what it is.

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

### After a code change

A running collector executes the `daemon.js` it started with. Pulling does
not change that, and neither does the hard reset `publish.js` does onto the
remote — the new file lands on disk and the old process carries on ignoring
it, publishing a `status.json` that has never heard of whatever was added.
Nothing looks wrong: the process is alive and the rounds are healthy.

Three things now handle it, in the order they get the chance:

```bash
powershell -File start-collector.ps1 -Status   # says whether it is running old code
powershell -File start-collector.ps1 -Stop; powershell -File start-collector.ps1
```

The daemon checks its own sources between rounds and hands over to a fresh
process when they change. The watchdog checks the same thing every fifteen
minutes, and restarts the collector when the files on disk are newer than
the process — that one is the backstop, because it is re-read from disk on
every run, so it works even when the running code is too old to check
anything itself. **The watchdog only exists if it has been installed:**

```bash
powershell -ExecutionPolicy Bypass -File watchdog.ps1 -Install
```

Without it, and with a collector old enough to predate the self-handover,
the two commands above are the way.

Run it on Node 26 or newer. Node 24's bundled HTTP client (undici 7) kills
the process with an uncatchable `assert(!this.paused)` when a server closes
the socket on an unread response body — nodejs/undici#5360, fixed in undici
8.4.1 and never backported to 7. `start-collector.ps1` picks the newest
Node 26+ that nvm-windows has installed when the one on PATH is older.

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
node lib/osm.js --all --parallel=3   # every country, several at a time
node lib/osm.js --status             # what has been imported
node lib/osm.js ES PT BR             # named countries
```

**Overpass is the bottleneck, and more parallelism does not fix it.** The
mirrors publish their limits at `/api/status` — measured 2026-08-08,
`overpass-api.de` allows two queries at a time per IP, while
`kumi.systems`, `private.coffee` and `maps.mail.ru` declare no limit.
Beyond a handful in flight the extra workers collect refusals, and when
mirrors are down — which happens — they only queue on whatever is left.

**Every mirror can be down at once, and on 2026-08-31 they were.** Three
mirrors read as redundancy right up to the morning kumi and private.coffee
both answered `502` while `overpass-api.de` stopped answering this address
at all: the TCP connect times out on both of its IPs while
openstreetmap.org itself is fine, which is a firewall, not a busy server.
Nothing had been imported since 25 August and the log was a wall of
`busy (502)`. Two changes came out of it. A fourth, independently operated
global mirror (`maps.mail.ru`, the VK one, the only other free planet-wide
instance the OSM wiki lists), and a health check: one cheap `/api/status`
call per mirror before the countries start, and a mirror that fails three
times running is benched for fifteen minutes. Without it a dead mirror
costs every request its full timeout, and the round's whole Overpass slice
goes on servers that are not there. Only whole-planet mirrors belong in
that list — a regional extract like `overpass.osm.ch` answers a Malta query
with `200` and zero elements, which reads as "no clubs here" and would file
the country as done.

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

**Overture Maps** — `lib/overture.js`. Seventy-four million places, from a
public S3 bucket with nothing to sign up for. It is the counterweight to
Overpass: no query service to overload, no mirrors to go down, just sixteen
Parquet files that either download or do not.

```bash
node lib/overture.js --index       # build the row-group index, once per release
node lib/overture.js --status      # how far the walk has got
node lib/overture.js --scan --cc=BR --verbose   # read a slice, save nothing
node lib/overture.js --import      # read a slice and keep what it finds
```

Three reasons it earns its place over the alternatives. Its schema carries
`emails`, `websites` and `socials` per place, so a fair share of records
arrive with the address already on them instead of costing a site crawl.
It contains no OpenStreetMap data — Overture says so plainly — so it cannot
be re-collecting what `lib/osm.js` already has. And its licence is CDLA
Permissive 2.0 and Apache 2.0, with none of the ODbL's share-alike
obligation, which is the thing that keeps OSM a source of candidates here.

Foursquare's own release was the other candidate and is deliberately not
used. Its public S3 bucket answers a listing of `release/` with zero keys —
the data moved to a gated Hugging Face dataset in early 2026, so a form, an
account and a token. Nothing else here needs an account, and Foursquare is
already one of Overture's four upstream providers, alongside Meta, Microsoft
and PinMeTo.

**Reading Parquet without a package.json.** `lib/parquet.js` is a reader cut
down to the one shape Overture publishes: ZSTD, v1 data pages,
RLE_DICTIONARY values, RLE levels, three-level lists. Anything outside that
throws by name rather than guessing, because a reader that guesses at an
encoding returns plausible rubbish, and rubbish shaped like a club name gets
published as a club.

**10.5 GB is not downloaded.** The files are sorted west to east and each row
group publishes the box it covers — a degree of longitude by half a degree of
latitude, typically — so a country is a box test against the footer
statistics. The index that holds those boxes and the byte range of every
column worth reading is 2.4 MB, built once per release from sixteen footer
reads. After that a round reads only the row groups that touch a country in
the brief: 2,607 of the 4,096 there are.

Each of those is read twice over. The first pass takes the name, the category
and the address's country code — about a third of the bytes — and the
contact columns are only fetched for a row group that has something in it
worth the rest. Four row groups run at once: the same 87 MB of Brazil took
2m26s one at a time and 59s at four.

**What it turns down is most of what it sees.** On that Brazil pass, 1,128
racket places became 81 records and 933 rejections. Shops are the bulk of it —
Overture files a padel retailer as `sporting_goods`, which contains "sport"
and passes any test for "is this a sports venue" — and the ones the category
does not catch are caught by the name: "TÊNis Viral Modas" is filed as
`tennis_court` and sells clothes off a MercadoLivre link.

A name that describes a facility rather than a club — "Quadras de Tênis",
"Cancha de Padel" — is allowed to merge into a club already on file and never
to start a record. Keyed by website that is exactly right: three such rows
against `iatebsb.com.br` are the Iate Clube de Brasília's tennis courts, its
squash court and its beach tennis, and they become one club that plays two of
the four. The same row against a hotel's website would otherwise invent
"Quadras de Tênis" as a Brazilian tennis club, and a hotel with a court is
not a club.

**It runs second in the round, not last.** The first wiring put it at the end
of the reading lane and in an eight-minute round it never ran at all: the
phases ahead of it work until the deadline and there is never a remainder.
That is the same reason the OpenStreetMap import shows 88 of 93 countries
still pending, and it is worth knowing before adding anything else to the
tail of that lane.

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

It works in passes. Every term is asked of every city once, biggest city
first, and when the last query of the last country has been asked the
whole list is searched again, because sites change and engines re-rank.
The page says which pass it is on, in words, at the top of the Cities
card and the Search coverage tab, and keeps what the previous pass found
beside it — every counter under that line starts from zero each pass, so
without it a second lap reads exactly like a collector that forgot
everything. `data/prospect.json` is the ledger of what has been asked. It
is not in git, and when it is lost with the rest of `data/`, most of it
comes back from the `status.json` that is:

```bash
node scripts/restore-prospect.js --from=git:<commit>          # what would change
node scripts/restore-prospect.js --from=git:<commit> --apply  # with the collector stopped
```

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
lib/overture.js     Overture Maps importer — 74M places from a public bucket
lib/parquet.js      the part of Parquet that Overture uses, and no more
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

**A running collector does not notice that it has been updated.** Node reads
a file once, so the daemon.js in memory is the one the process started with.
`publish.js` does `git reset --hard origin/<branch>` whenever the branch has
moved, which is how a change reaches the collector at all — so every fix
lands on disk, correctly, and is then ignored for as long as the process
stays up. The Overture importer was merged, pulled, written to disk, and
went on being absent from every `status.json` the collector published,
because the process writing them had never heard of it. The watchdog does
not catch this: it restarts a collector that is dead or wedged, and this one
is healthy and old. The round loop now fingerprints its own sources between
rounds and hands over to a fresh process when they change.

**A phase at the end of the reading lane does not run.** The phases ahead of
it work until the deadline and there is no remainder. Overture was wired in
at the end and executed exactly zero times; OpenStreetMap sat there too, and
that is most of why it had 82 of 93 countries pending after weeks. Both
importers now take their slice out of the crawl's before the round starts,
rather than hoping for what is left.

**Running out of the round is not Overpass refusing.** The two were recorded
as the same thing: a country cut off by the deadline was filed with an error,
counted towards the circuit breaker, and three of them in a row had the round
announce that Overpass was not answering today — while every mirror answered
every request it was given. The page then showed "OpenStreetMap is refusing
queries" over a morning of successful imports. A timeout now says so, keeps
whatever `partial:` progress the country had, and leaves the breaker alone.

**Twelve countries a round finished none of them.** The slice is shared, and
a country's first act is an area lookup that takes longer than the seconds it
was getting, so every country was started and none completed. Four a round,
with the subdivision lookup on a budget of its own so a slow one gives its
turn back instead of spending the whole slice waiting. Measured on one round
after the change: Britain +301 clubs and Spain +148, against about 16 every
third round before it.

**What is still not fixed about Overpass.** On a bad hour the mirrors answer
a country-wide query with something that reads as "too big", the country
falls into the split path, and the lookup of its own subdivisions then times
out as well — so Brazil can still spend a turn and save nothing. The budget
above caps that at two and a half minutes instead of a whole slice, and the
subdivision list is kept whenever it is obtained, but neither helps when the
lookup itself never returns. This is what the free mirrors are; Overture now
covers the same ground without depending on them.

## Tuning

```
TICK_MINUTES=60  BUDGET_MINUTES=20  CONCURRENCY=8  HOST_DELAY_MS=2000
PAGES_PER_TICK=25  OSM=off  LTA_MINUTES=6  LTA=off
OVERTURE_MINUTES=6  OVERTURE_MB=150  OVERTURE_PARALLEL=4  OVERTURE=off
CRAWL_MINUTES=12  CONTACT_PAGES=30  SITE_MS=150000  PROSPECT_MINUTES=18  PLACE_MINUTES=3
PAGE_TIMEOUT_MS=5000  SLOW_PAGE_TIMEOUT_MS=15000  RETRY_MINUTES=10
VET_PARALLEL=4  SEARCH_GAP_MS=10000  SEARCH_GAP_MAX_MS=120000  SEARCH_TIMEOUT_MS=12000
SEARCH_COOLDOWN_MS=300000  SEARCH_COOLDOWN_MAX_MS=900000  SEARCH_PAGES=1
SEARCH_OUTAGE_REST_MS=60000  SEARCH_OUTAGE_REST_MAX_MS=300000
```

`SLOW_PAGE_TIMEOUT_MS` is the page timeout for the second look at a site the
ordinary five seconds called unreachable — the next day, then after three
days, a week, and monthly from there. `SEARCH_TIMEOUT_MS` is how long the
search engine gets to answer; a request that gets no answer at all is
retried once on the other endpoint and then counted as an outage
(`SEARCH_OUTAGE_REST_*`, a minute doubling to five) rather than as a
refusal, which is what doubles the gap and starts the longer cooldown.
