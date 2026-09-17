# The scenarios

Sixteen pages, one per caching feature this demo uses. Each one says what to send, what comes
back, and which response header proves it. Read them in order: the early pages establish the
vocabulary the later ones lean on.

## Before you start

Two shells' worth of setup. `EDGE` is the GraphPilot service in front of this API, which is where
every caching claim on these pages is made. `ORIGIN` is this API itself, which is useful exactly
twice: to see what an unproxied answer looks like, and to reset the data.

```sh
export EDGE=https://demo.graphpilot.cloud
export ORIGIN=https://demo-api.graphpilot.cloud
export SERVICE=demo
```

`SERVICE` is the service subdomain the purge pages hand to `gpilot --service`. Purging needs a
GraphPilot login (`gpilot login`) and a token that may purge this service, so those pages are
followable in full only by someone who owns one. Everything before them needs nothing but curl.

Running the demo locally instead? `ORIGIN=http://localhost:4000`, and there is no `EDGE`: the
cache lives in GraphPilot, not in this repository. Point your own service at a local tunnel if you
want to follow along end to end. See the root `README.md`.

Every request below sends one extra header:

```sh
-H 'gp-client-name: demo-curl'
```

That is the `[[client.profile]]` in `gpilot.toml`. It changes nothing about how a response is
cached; it only labels the request in `gpilot requests`, so a walkthrough can be told apart from
whatever else is calling a public demo.

### A token

Several pages need a verified identity. This demo mints its own:

```sh
TOKEN=$(curl -sS "$ORIGIN/auth/token" \
  -H 'content-type: application/json' \
  -d '{"sub":"user-ada","org":"org-acme","role":"admin"}' | jq -r .token)
```

The three fields become the three claims `gpilot.toml` reads: `sub` keys a private entry,
`org_id` and `role` derive the two bucket headers. Nothing else in the token matters here.

### Starting from a known state

Prices and reviews change as people try the mutations. Reset before a walkthrough that compares
two answers:

```sh
curl -sS -X POST "$ORIGIN/admin/reset"
```

This endpoint belongs in no real API. It exists so a scenario starts from the seeded catalogue
instead of from whatever the last reader left behind.

## The header vocabulary

Every page ends by naming a header. These are the ones that appear:

| Header | What it says |
| --- | --- |
| `gp-cache` | `MISS`, `HIT`, `STALE` or `PASS`. The one header that answers "was this stored". |
| `gp-cache-reason` | Why, when the answer is not a plain hit. `CACHE_SKIPPED_PRIVATE_WITHOUT_DISCRIMINATOR` and friends. |
| `gp-cache-age` | Seconds since the entry was stored. Counts up across hits on one entry. |
| `gp-cache-max-age` | The fresh lifetime the entry was given, in seconds. The schema's `maxAge`, after the whole selection has been minimised over. |
| `gp-cache-remaining` | Seconds of freshness left. `gp-cache-max-age` minus `gp-cache-age`. |
| `gp-cache-hits` | How many times this entry has been served. |
| `gp-surrogate-key` | The keys the entry is tagged with, which are the keys a purge names. Off by default; `gpilot.toml` switches it on here. |

`gp-cache-*` is on because `response.cache_headers` defaults to on. `gp-surrogate-key` is on
because `gpilot.toml` says so; in a real service it is a debugging aid you switch on when you want
it.

One more, and it is not ours: `cf-cache-status`. If Cloudflare's own cache answered, you are not
measuring GraphPilot's. Nothing on these pages should ever show a `cf-cache-status` of `HIT`.

## Reading order

**Lifetime: how long an answer lives**

1. [MISS, then HIT](01-miss-then-hit.md) - the whole loop, on one product.
2. [The stale window](02-stale-window.md) - `swr`, and why nobody waits for the origin.
3. [A short field caps the whole response](03-short-field-caps-the-response.md) - `inventory` at five seconds.
4. [`inheritMaxAge`](04-inherit-max-age.md) - the opposite move: a child that keeps its parent's lifetime.
5. [Never stored](05-never-stored.md) - `now` and every mutation, the reference point for "fresh".

**Identity: who shares an answer**

6. [Public scope](06-public-scope.md) - one entry for everyone.
7. [Private scope](07-private-scope.md) - one entry per subject, proved with two tokens.
8. [Buckets](08-buckets.md) - one entry per organization and role.
9. [Variables in the cache key](09-variables-in-the-key.md) - every search term its own entry.
10. [An API key caches nothing](10-api-key-vs-jwt.md) - no claims, no discriminator, no entry.

**Invalidation: getting an answer back out**

11. [Entity keys](11-entity-keys.md) - purge one product.
12. [Path keys](12-path-keys.md) - purge a whole category.
13. [Static keys](13-static-keys.md) - the coarse lever.
14. [Collection keys](14-collection-keys.md) - the object that does not exist yet.

**The edges of the system**

15. [Origin signature](15-origin-signature.md) - proving the request came from the edge.
16. [Persisted operations](16-persisted-operations.md) - serving an operation by its hash.
