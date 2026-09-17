# The stale window

**What this shows:** an entry past its fresh lifetime is not immediately gone. Within the window
`swr` declares, the edge hands over the stored copy right away and fetches a fresh one behind the
reader's back, so nobody waits for the origin.

`Query.activity` exists for this page. Every other stale window in this schema is measured in hours,
which is the honest lifetime for a catalogue and useless for showing the mechanism: nobody waits an
hour to watch an entry go stale. The activity feed is five seconds fresh and a minute stale, so the
whole cycle fits inside a coffee sip.

```graphql
activity(first: Int = 5): Activity!
    @cacheControl(maxAge: 5, scope: PUBLIC, swr: 60)
    @surrogateKey(static: "activity")
```

`Activity.observedAt` is what makes the mechanism visible. It is stamped in the resolver and
nowhere else, so it moves if and only if the origin was actually reached. Everything below is read
off that one field.

## Send this

`-i` puts the headers and the body in one stream, so a single grep shows both halves of the
evidence:

```sh
feed() {
  curl -sS -i "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d '{"query":"query Feed { activity { observedAt } }"}' \
    | grep -iE '^gp-cache|observedAt'
}

feed          # 1: cold
feed          # 2: immediately after
sleep 6
feed          # 3: past maxAge, inside swr
sleep 1
feed          # 4: after the revalidation
```

## What comes back

**1, cold.** The origin runs, the entry is stored.

```
gp-cache: MISS
gp-cache-max-age: 5
{"data":{"activity":{"observedAt":"2026-09-17T11:00:00.000Z"}}}
```

**2, immediately.** A plain hit, and `observedAt` is the same string. The origin was not reached.

```
gp-cache: HIT
gp-cache-age: 1
gp-cache-remaining: 4
{"data":{"activity":{"observedAt":"2026-09-17T11:00:00.000Z"}}}
```

**3, after six seconds.** The entry has expired, and the answer arrives as fast as the hit did.
`observedAt` is still the original one: this is the stored copy being served past its freshness,
while a revalidation runs behind it.

```
gp-cache-age: 6
{"data":{"activity":{"observedAt":"2026-09-17T11:00:00.000Z"}}}
```

**4, a second later.** `observedAt` has moved. The revalidation reached the origin and replaced the
entry, and nobody waited for it to happen.

```
gp-cache: HIT
gp-cache-age: 0
{"data":{"activity":{"observedAt":"2026-09-17T11:00:07.000Z"}}}
```

## Which header proves it

Read the body first, then the headers. `observedAt` is the reliable evidence, because it is
produced by the origin and cannot be produced by anything else: an unchanged `observedAt` is proof
the request never got there, and a changed one is proof it did.

On the headers, watch `gp-cache-age`. Request 3 has an age above `gp-cache-max-age`, and an entry
served while older than its own lifetime is a stale serve by definition.

**On the status label for request 3, this page makes no promise.** The proxy has a `STALE` value
for `gp-cache` and this is what it is for, but no one has yet watched this schema go stale against a
running edge, so the label is written here as something to check rather than something to expect.
If you run the sequence above, the honest report is whatever `gp-cache` actually said. The two
facts underneath it, an age past the lifetime and an unchanged `observedAt`, hold whatever it is
labelled.

## Notes

- `swr` is time past `maxAge`, not total. `maxAge: 5, swr: 60` means sixty-five seconds before the
  entry is worthless, five of them fresh.
- Wait more than sixty-five seconds and request 3 is an ordinary `MISS` with a new `observedAt`.
  That is the window closing, and it is worth doing once so you have seen both.
- **Selecting `entries` changes the answer, and not in a small way.** `ActivityEntry` carries a
  `@surrogateKey` but no `@cacheControl`, and a composite type with no lifetime of its own resolves
  to the schema's default, which is zero. Zero is the minimum over the selection, so
  `activity { entries { name } }` is not cached at all: `gp-cache-reason: CACHE_SKIPPED_NO_MAX_AGE`,
  every time. It is the same rule as [page 3](03-short-field-caps-the-response.md), with the
  short lifetime arriving by omission rather than by choice, and it is the single easiest way to
  make a thoroughly annotated schema cache nothing. Run it once, see the reason code, and remember
  the shape.
- A purge removes an entry outright, so a purged entry has no stale window left to serve from. A
  soft purge is the version that keeps it: see [entity keys](11-entity-keys.md).
