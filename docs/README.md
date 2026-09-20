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

The token is issued by `graphpilot-demo-api` to the audience `graphpilot-demo-api`, since the demo
is its own identity provider, and the JWT provider block in `gpilot.toml` names both of those
strings. A token from anywhere else is refused at the edge.

### Starting from a known state

Prices and reviews change as people try the mutations, so a page that compares two answers is
easier to follow from the seeded catalogue.

`POST /admin/reset` restores it, and it is guarded, because an unauthenticated endpoint that throws
away everyone's data is worse than no reset at all. Which guard depends on how the origin is
running:

| Origin | Guard on `/admin/reset` |
| --- | --- |
| deployed, signatures on | the origin signature. Only a signed request gets through, so only something holding the service's signing key can reset it. |
| `REQUIRE_SIGNATURE=false` | `x-admin-token` must match `ADMIN_TOKEN`, and with `ADMIN_TOKEN` unset the reset is refused outright. |
| local `pnpm start` | not served at all. It is a Worker route. Restart the process, which reseeds. |

**So on a shared deployed demo you will not be resetting anything,** and that is deliberate: the
guard is the same one protecting the API. The reset exists for the system-test suite, which holds
the key, and for your own instance. If you are following these pages against a demo somebody else
deployed, treat the data as shared and read the pages that compare two answers with that in mind,
or run your own copy:

```sh
REQUIRE_SIGNATURE=false pnpm start
```

Nothing in the walkthroughs needs a reset to make its point. Only the exact prices do.

## The header vocabulary

Every page ends by naming a header. These are the ones that appear:

| Header | What it says |
| --- | --- |
| `gp-cache` | `MISS`, `HIT`, `STALE` or `PASS`. The one header that answers "was this stored": `MISS` went to the origin and stored the answer, `PASS` stored nothing. |
| `gp-cache-reason` | Why nothing was stored. Present on every `PASS` and on nothing else. The prefix says where the decision fell: `CACHE_PASS_*` before the cache was consulted, `CACHE_SKIPPED_*` after the origin answered. |
| `gp-cache-age` | Seconds since the entry was stored. Counts up across hits on one entry. |
| `gp-cache-max-age` | The fresh lifetime the entry was given, in seconds. The schema's `maxAge`, after the whole selection has been minimised over. |
| `gp-cache-remaining` | Seconds of freshness left. `gp-cache-max-age` minus `gp-cache-age`. |
| `gp-cache-hits` | How many times this entry has been served. |
| `gp-surrogate-key` | The keys the entry is tagged with, which are the keys a purge names. Off by default; `gpilot.toml` switches it on here. |

`gp-cache-*` is on because `response.cache_headers` defaults to on. `gp-surrogate-key` is on
because `gpilot.toml` says so; in a real service it is a debugging aid you switch on when you want
it.

**The `gp-` spellings are the authoritative ones, and they are the only ones you will see.** This
is worth stating because the bare names are the obvious guess and every one of them is wrong here:

| You might look for | What is actually true |
| --- | --- |
| `age` | not emitted. The entry's age is `gp-cache-age`. |
| `surrogate-key` | the origin's own inbound header. The edge reads it, folds its keys into `gp-surrogate-key`, and strips the original from your copy. |
| `x-cache`, `x-cache-hits` | Fastly's, describing the origin fetch, which always passes. They said `MISS` beside our `HIT`, so they are stripped too. `gp-cache` is the answer. |

All three come from one registry in the proxy
(`gp-proxy/src/support/reserved_headers/strip_reserved_headers.rs`), which is also what the
response scrub reads, so a name the proxy sets and a name it strips cannot drift apart.

One header that is not ours and is not stripped: `cf-cache-status`. If Cloudflare's own cache
answered, you are not measuring GraphPilot's. Nothing on these pages should ever show a
`cf-cache-status` of `HIT`.

## Reading order

**Lifetime: how long an answer lives**

1. [MISS, then HIT](01-miss-then-hit.md) - the whole loop, on one product.
2. [The stale window](02-stale-window.md) - `swr` on the activity feed, five seconds fresh and a minute stale, so the cycle is watchable.
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
