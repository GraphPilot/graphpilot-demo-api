# MISS, then HIT

**What this shows:** the whole caching loop on one long-lived type. The first request reaches the
origin and is stored; the second is answered at the edge, and the age of the stored answer counts
up.

`type Product` in `src/schema.graphql` carries `@cacheControl(maxAge: 3600, scope: PUBLIC, swr: 3600)`.
An hour of freshness, shared by everyone. That is the only statement behind everything below.

## Send this

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query OneProduct { product(id: \"p01\") { id name price rating } }"}' \
  | grep -i '^gp-'
```

Run it twice, a second or two apart.

## What comes back

First run:

```
gp-cache: MISS
gp-cache-max-age: 3600
gp-surrogate-key: Product:id:p01 catalogue
```

`Product` declares three keys, and only two of them are here. The third,
`Product:category.id:<id>`, is built from a value this query did not ask for: a key over a path can
only be filled from what the response actually carries. Select `category { id }` and it appears.
That is [page 12](12-path-keys.md).

Second run:

```
gp-cache: HIT
gp-cache-age: 2
gp-cache-hits: 1
gp-cache-max-age: 3600
gp-cache-remaining: 3598
```

The response body is byte for byte the same. That is the point: within `maxAge` the edge is
allowed to repeat itself, and it does.

## Which header proves it

`gp-cache`. `MISS` means the edge went to the origin and stored what it got; `HIT` means it did not
go anywhere. A `MISS` is therefore already the whole claim, and it never carries a
`gp-cache-reason`. When the edge keeps nothing the status is `PASS`, and that always says why,
which is [page 5](05-never-stored.md).

If you want to see the age climb, run the request a third and fourth time and watch `gp-cache-age`
grow and `gp-cache-remaining` shrink by the same number of seconds.

## Notes

- `inventory` is deliberately not selected here. It carries its own five-second lifetime and would
  cap this response at five seconds instead of an hour. That is [page 3](03-short-field-caps-the-response.md).
- `gp-cache-max-age` reports 3600, not whatever the longest-lived type in the schema is. It is the
  minimum over everything the query selected, which for this selection is `Product`'s own hour.
- After the hour is up the entry does not simply vanish. See [the stale window](02-stale-window.md).
