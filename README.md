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

### Once an hour, by itself

```bash
powershell -ExecutionPolicy Bypass -File install-windows.ps1
```

Registers a Windows Scheduled Task that runs one round an hour and pushes
the result. `-Remove` takes it away again. It refuses to install into a git
worktree, because those get pruned and the task would then fail silently
once an hour forever.

Watch it: `Get-ScheduledTaskInfo -TaskName RacketClubCollector`
Log: `data/daemon.log`

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

**OpenStreetMap** — `lib/osm.js`. Federation directories only exist where
there is a federation with a crawlable website, which leaves most of the
eighty-three countries with nothing: there is no Tuvalu tennis directory.
OSM covers all of them, through the public Overpass endpoint — read-only,
no key, no account.

```bash
node lib/osm.js --all        # every country, priority order
node lib/osm.js --status     # what has been imported
node lib/osm.js ES PT BR     # named countries
```

It keeps places that publish a website or an email. Named clubs with
neither go to `data/osm-leads.json` rather than being discarded, so they
are not rediscovered every run.

**The site crawl.** Anything with a website but no email yet gets its
homepage and up to six likely contact pages read, in Spanish, Portuguese
and English. Cloudflare-obfuscated and "info [at] club [dot] com" style
addresses are decoded.

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
PAGES_PER_TICK=25  OSM=off
```
