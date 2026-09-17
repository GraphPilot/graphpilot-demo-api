# Never stored

**What this shows:** the reference point. Two answers in this schema are guaranteed to have come
from the origin, every single time, so you can use them to tell a real origin visit apart from a
cache hit.

`Query.now` carries `@cacheControl(maxAge: 0)`. `type Mutation` carries the same, once, on the
type, so no individual write has to remember.

## Send this

```sh
curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query Clock { now }"}' \
  | grep -iE '^gp-cache|"now"'
```

Twice, a second apart.

And a write:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"mutation Reprice { setPrice(id: \"p01\", price: 2450) { id price updatedAt } }"}' \
  | grep -i '^gp-cache'
```

## What comes back

`now`, both times:

```
gp-cache: MISS
gp-cache-reason: CACHE_SKIPPED_NO_MAX_AGE
```

with a different timestamp in the body each time. The mutation:

```
gp-cache: MISS
gp-cache-reason: CACHE_SKIPPED_UNCACHEABLE_OPERATION
```

## Which header proves it

`gp-cache-reason`. This is the header worth understanding properly, because `gp-cache: MISS` on
its own is ambiguous: it says the edge went to the origin, and says nothing about whether it kept
what it got. A `MISS` that stores carries no reason at all. A `MISS` that stores nothing names why.

`CACHE_SKIPPED_NO_MAX_AGE` is `maxAge: 0` arriving at the store step with no lifetime to give the
entry. `CACHE_SKIPPED_UNCACHEABLE_OPERATION` is the flat rule above it: only a query is ever
written to the cache, whatever a mutation's annotations say.

The two timestamps are the belt to those braces. A stored `now` would repeat itself.

## Notes

- Use `now` whenever you are unsure whether you are looking at a cached answer. Put it in the same
  operation as whatever you are testing and it will tell you, at the cost of making that operation
  uncacheable too, which is exactly why it is its own query here.
- There is a fourth `gp-cache` value, `PASS`, which you will not see on these pages. It means the
  cache was never consulted at all, for a reason that has nothing to do with the response: a
  `cache.policy.bypass` expression, a client profile with `cache = "off"`, an `OPTIONS` preflight.
  This demo configures none of those.
- A mutation is never cached, but it is not inert either: the keys it carries are what evicts the
  queries that read the data it changed. See [entity keys](11-entity-keys.md).
- After running the `setPrice` above, `POST $ORIGIN/admin/reset` puts the catalogue back.
