# The stale window

**What this shows:** an entry past its fresh lifetime is not immediately gone. Within the window
`swr` declares, the edge hands over the stored copy right away and fetches a fresh one behind the
reader's back, so nobody waits for the origin.

`Query.products` carries `@cacheControl(maxAge: 300, scope: PUBLIC, swr: 600)`: five minutes fresh,
then ten more minutes during which a stale answer is better than a slow one.

This is the shortest window in the schema, which is why the walkthrough uses it. `Product` has an
hour plus an hour, `Category` a day plus a week.

## Send this

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query Catalogue { products(first: 5) { id name price } }"}' \
  | grep -i '^gp-cache'
```

Once now, once again immediately, and once more after five minutes have passed.

## What comes back

Immediately, the familiar pair:

```
gp-cache: MISS
gp-cache-max-age: 300
```

```
gp-cache: HIT
gp-cache-age: 1
gp-cache-remaining: 299
```

After five minutes:

```
gp-cache: STALE
gp-cache-age: 303
gp-cache-remaining: 0
```

The answer arrives as fast as the hit did. A revalidation is running behind it, so the request
after that one is a `HIT` again with `gp-cache-age` back near zero.

## Which header proves it

`gp-cache: STALE`. It is a distinct value from both `HIT` and `MISS`, and it is the only evidence
that the stale window did anything: without `swr`, minute six would have been a `MISS` and the
reader would have waited for the origin.

## Notes

- `swr` is time past `maxAge`, not total. `maxAge: 300, swr: 600` means fifteen minutes before the
  entry is worthless, five of them fresh.
- A stale answer is a real answer, not an error. If your data cannot tolerate being a few minutes
  old, the fix is a shorter `maxAge` or a purge, not a shorter `swr`.
- A purge removes an entry outright, so a purged entry has no stale window left to serve from. A
  soft purge is the version that keeps it: see [entity keys](11-entity-keys.md).
