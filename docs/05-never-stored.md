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
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_NO_MAX_AGE
```

with a different timestamp in the body each time. The mutation:

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_UNCACHEABLE_OPERATION
```

## Which header proves it

`gp-cache`, and it is not ambiguous. The two statuses divide on one question, whether anything was
stored:

- **`MISS`**: the edge went to the origin and stored the answer. It never carries a reason.
- **`PASS`**: nothing was stored. It always carries a reason.

So a `PASS` is the answer to "this did not cache", and the next identical request will go to the
origin again.

`gp-cache-reason` then says *where* the decision was made, which is the only thing its prefix tells
you:

| Prefix | Where the decision fell | Status |
| --- | --- | --- |
| `CACHE_PASS_*` | before the cache was consulted, so about the request | `gp-cache: PASS` |
| `CACHE_SKIPPED_*` | after the origin answered, so about the response | `gp-cache: PASS` |

Both report `PASS`, because both mean nothing was stored. The names are historical: `CACHE_SKIPPED_*`
is published API and was deliberately left alone when the statuses were tightened, so read the
prefix as "when", not as "what happened".

`CACHE_SKIPPED_NO_MAX_AGE` is `maxAge: 0` arriving at the store step with no lifetime to give the
entry. `CACHE_SKIPPED_UNCACHEABLE_OPERATION` is the flat rule above it: only a query is ever
written to the cache, whatever a mutation's annotations say. Both are decided after the origin has
answered, which is why they are `SKIPPED` and not `PASS` reasons.

The two timestamps are the belt to those braces. A stored `now` would repeat itself.

## Notes

- Use `now` whenever you are unsure whether you are looking at a cached answer. Put it in the same
  operation as whatever you are testing and it will tell you, at the cost of making that operation
  uncacheable too, which is exactly why it is its own query here.
- You will not see a `CACHE_PASS_*` reason on these pages, because that family needs a configuration
  this demo does not have: a `cache.policy.bypass` expression, a client profile with `cache = "off"`,
  an `OPTIONS` preflight, or the cache being unreachable. When you do meet one, it looks exactly like
  the responses above except for the reason, which begins `CACHE_PASS_` and names which of those it
  was. The status is `PASS` either way.
- A mutation is never cached, but it is not inert either: the keys it carries are what evicts the
  queries that read the data it changed. See [entity keys](11-entity-keys.md).
- The `setPrice` above really does change the data, and on a shared demo it changes it for
  everyone. [The index](README.md) explains what resetting takes, and why you probably cannot.
