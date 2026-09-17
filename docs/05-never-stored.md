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

Read the prefix, not just the presence. The header carries two families, and they answer different
questions:

| Prefix | What happened | Goes with |
| --- | --- | --- |
| `CACHE_SKIPPED_*` | the cache was consulted, and refused to store what came back | `gp-cache: MISS` |
| `CACHE_PASS_*` | the cache was never consulted at all | `gp-cache: PASS` |

Either way nothing was stored: a pass never reaches a store attempt, so the two can never both
apply. That is why the header's presence alone is still a reliable "this did not cache", and why
the prefix is what tells you whether the decision was about the response or about the request.

The two timestamps are the belt to those braces. A stored `now` would repeat itself.

## Notes

- Use `now` whenever you are unsure whether you are looking at a cached answer. Put it in the same
  operation as whatever you are testing and it will tell you, at the cost of making that operation
  uncacheable too, which is exactly why it is its own query here.
- You will not see `PASS` on these pages, because it needs a configuration this demo does not have:
  a `cache.policy.bypass` expression, a client profile with `cache = "off"`, an `OPTIONS` preflight,
  or the cache being unreachable. When you do meet one, it looks like the responses above except
  for the two values that matter: `gp-cache: PASS`, and a reason beginning `CACHE_PASS_` rather
  than `CACHE_SKIPPED_`, naming which of those it was.
- A mutation is never cached, but it is not inert either: the keys it carries are what evicts the
  queries that read the data it changed. See [entity keys](11-entity-keys.md).
- After running the `setPrice` above, the reset endpoint puts the catalogue back. See
  [the index](README.md), which is also where the guard on it is explained.
