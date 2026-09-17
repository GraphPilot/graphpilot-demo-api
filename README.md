<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/banner-light.svg">
    <img alt="GraphPilot Demo API" src=".github/assets/banner-light.svg" width="640">
  </picture>
</p>

# GraphPilot demo API

A small GraphQL product catalogue whose only job is to show what every GraphPilot edge caching
feature does, in a place where its effect is visible and explainable.

Two files carry the whole story. `src/schema.graphql` says what each type and field is worth:
how long it lives, who may share it, and which surrogate keys a purge can name it by. `gpilot.toml`
says how the edge derives an identity from a request, which is the other half of the same
question. Every annotation in the first and every block in the second carries a comment saying what
it demonstrates and why.

`docs/` walks through it one scenario at a time. Each page has a runnable curl, the answer it
produces, and the response header that proves the claim. Start at [docs/README.md](docs/README.md).

**This is a demo.** The catalogue is twenty seeded products and no real database, the Worker has a
`POST /admin/reset` endpoint that throws them away and reseeds, and the demo mints its own tokens
for anyone who asks. None of those three belongs in a real API. Everything else here is meant to be
copied.

## Run it

```sh
corepack pnpm@9.15.0 install
pnpm start
```

The server listens on `http://localhost:4000`:

- `POST /graphql`, and `GET /graphql` for GraphiQL in a browser
- `POST /auth/token` takes `{"sub": "...", "org": "...", "role": "..."}` and returns a signed RS256 token
- `GET /auth/jwks.json` publishes the key that verifies it
- `GET /health`

`POST /admin/reset` is not in that list on purpose: it is a route on the Worker only. A local run
reseeds by restarting.

Node 26 or newer, which runs the TypeScript sources directly. No build step.

### On Workers, the way it is deployed

```sh
pnpm dev:worker
```

`wrangler dev` reads `wrangler.jsonc` (wrangler 4 prefers JSONC, and both `wrangler types` and the
Vitest pool find it there without being told). The Worker serves the same routes plus
`POST /admin/reset`, and keeps the catalogue in one Durable Object rather than in memory, so a
write and the read after it meet the same database. That is not a detail: "the cache is invalidated
on write" is only an honest claim if the origin serves the new value on the very next read.

The SQLite-backed Durable Object is what the Workers **free** plan supports. Cloudflare's pricing
page puts it plainly: "Workers Free plan: Only Durable Objects with SQLite storage backend are
available." It is the key-value backend that needs a paid plan. The free limits are 100k
requests/day, 5M row reads/day, 100k rows written/day and 5 GB stored, all of them far above what a
demo catalogue of twenty products uses.

Signature verification guards `/graphql` (and `/admin/reset` on the Worker) and is on by default,
so it will refuse everything you send by hand, because nothing local is signing.
`REQUIRE_SIGNATURE=false pnpm start` turns it off for local work, with a warning on every request
while it is off. Do not set it anywhere real. The other routes are unsigned on purpose, and
[docs/15-origin-signature.md](docs/15-origin-signature.md) has the table saying which and why.

**With the guard on and no `SIGNING_KEY`, the origin answers 500 to everything, `/health`
included.** The check runs before routing, on both entry points, because the alternative is serving
unverified traffic while the configuration says the opposite. It fails closed and loudly rather
than quietly wide open. The deploy workflow turns that into a feature: a 200 from `/health` is
proof the signing key reached the Worker.

Key material differs by runtime, and the difference matters:

- **Node** generates a pair at startup when `AUTH_PRIVATE_JWK` is unset, and says so in a warning.
  A restart then invalidates every token already minted. Fine locally, wrong anywhere real.
- **The Worker** has no startup to generate anything in, and every isolate would otherwise reach a
  different answer. So without `AUTH_PRIVATE_JWK` the Durable Object generates one pair and every
  isolate reads that same pair back. That is correct rather than broken, which is why the variable
  is optional there. Set it anyway if you want to own the key and be able to rotate it.

Self-hosting instead: the `Dockerfile` is a single `node:26-alpine` stage with no build.

## Point your own GraphPilot service at it

1. **Give the origin a public URL.** Deploy this repository anywhere that will run it, or expose a
   local run through a tunnel. The edge has to be able to reach it, and so does GraphPilot at
   deploy time, because it fetches `jwks_url` then rather than on the request path.
2. **Create a service** and set its origin to that URL.
3. **Edit `gpilot.toml`.** One value is specific to where you deployed: `jwks_url` under
   `[auth.providers.demo]` has to name your origin's `/auth/jwks.json`. Everything else works as
   written, including `allowed_issuers` and `allowed_audiences`, which both name
   `graphpilot-demo-api` because that is what `src/auth/claims.ts` mints with. Change one and you
   have to change the other.
4. **Deploy the configuration before the schema, or together with it.** The schema's `ORGANIZATION`
   scope names two headers that the two `[[cache.policy.vary]]` entries derive. An annotation
   naming a header no entry derives is refused on every request, so the entries have to exist
   first. They are harmless early: until the schema names them, deriving a header does nothing.

   ```sh
   gpilot deploy
   ```

5. **Configure the origin's environment**, all of it, before pointing traffic at it:

   | Variable | Required | Why it matters |
   | --- | --- | --- |
   | `SIGNING_KEY` | yes | the signing key GraphPilot issued for the service. Without it the origin answers 500 to every route, `/health` included, rather than serving unverified traffic. Required unless `REQUIRE_SIGNATURE=false`. |
   | `AUTH_PRIVATE_JWK` | Node yes, Worker no | the RS256 key the demo signs tokens with. On Node, unset means a fresh pair per restart and every live token invalidated. On the Worker, unset means the Durable Object's own generated pair, which every isolate agrees on, so it is a real choice rather than a mistake. |
   | `ADMIN_TOKEN` | only with signatures off | the fallback guard on `POST /admin/reset`. With signatures on, the signature guards it and this is unused. With them off and this unset, the reset is refused outright, so switching the guard off never hands the reset to whoever finds the address. |
   | `REQUIRE_SIGNATURE` | no | leave it unset. `false` serves unverified requests and says so on every one. |

   `AUTH_PRIVATE_JWK` and `jwks_url` are two halves of one key: rotate the first and redeploy, or
   the edge keeps verifying against a key set the origin no longer signs with.

6. **Walk the docs.** Export `EDGE`, `ORIGIN` and `SERVICE` as [docs/README.md](docs/README.md)
   describes, and start at page 1.

## Deploying it

`.github/workflows/deploy.yml` runs on every push to `main`, and by hand through
`workflow_dispatch`. It checks, deploys the Worker, pushes the Worker's secrets, waits for the
origin to come up, then publishes the schema and `gpilot.toml` to the edge.

The order is the point. The Worker goes first so the origin is serving the new code before the edge
learns its schema, since an edge baking rules for a field the origin does not serve yet is the
worse failure. The schema and the config go in one `gpilot deploy`, which is what keeps the
`@vary` ordering rule satisfied without anyone having to think about it: the entries that derive
`x-gp-organization` and `x-gp-role` land in the same deployment as the annotation naming them.

### What it needs

Repository **secrets**:

| Secret | Needed before the first deploy | What it is |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes | a token with Workers Scripts edit permission. Without it nothing deploys. |
| `CLOUDFLARE_ACCOUNT_ID` | yes | the account the Worker belongs to. |
| `SIGNING_KEY` | yes | the per-service signing key GraphPilot issues. The workflow refuses to continue when it is empty, because a Worker without it answers 500 to everything. |
| `GPILOT_TOKEN` | yes | a GraphPilot API key that may deploy this service. Used as an environment variable rather than through `gpilot auth login`, which wants a terminal. |
| `AUTH_PRIVATE_JWK` | no | the RS256 private JWK. Left unset, the workflow says so and the Durable Object's own generated pair stays in use. |

Repository **variables**:

| Variable | Needed before the first deploy | What it is |
| --- | --- | --- |
| `GPILOT_SERVICE` | yes | the service subdomain `gpilot deploy --service` names. |
| `ORIGIN_URL` | yes | the deployed Worker's own URL, used for the health check between the two halves. No trailing slash. |

The Worker's name comes from `wrangler.jsonc`, not from a variable, so renaming the service there
renames what is deployed.

### The first run

The first deploy is the awkward one, and it is worth knowing why rather than being surprised by it.
`wrangler secret put` needs the Worker to exist, so the Worker is created before its secrets
arrive, and for those few seconds it is live and answering 500 to every request. That is the origin
failing closed, not a fault. The health check step is what proves the window closed: `/health`
needs no credential but is served only once `SIGNING_KEY` is in place, so one 200 shows both that
the deploy landed and that the secret reached it. If it never goes green the workflow stops without
publishing anything to the edge.

Nothing here creates the Cloudflare or GraphPilot side for you. The service, the token and the
hostnames are set up once by a human, and `jwks_url` in `gpilot.toml` still carries a placeholder
until they are.

## The one test worth stealing

`src/__tests__/cache-control-coverage.test.ts` walks the SDL and fails on the two annotation
mistakes that are invisible in review and silent in production:

- A **composite type with no `@cacheControl`**, reached from a field that does not inherit one. Such
  a field resolves to the default lifetime, and the default is zero unless the directive declaration
  gives `maxAge` one. A response lives for the shortest lifetime in everything it selects, so a
  single unruled type makes every response that touches it uncacheable. Nothing errors, nothing is
  logged, the cache simply never fills.
- A **field-level `@cacheControl` that leaves out `scope`** while the type it returns states one. A
  field's hint replaces the return type's rather than merging with it, and a hint naming no scope is
  read as private, so a public answer is stored once per caller.

Both have now been made in three different schemas, including this one. The test needs nothing but
`graphql` and your SDL, and its failure message names the type, the field and the consequence. Copy
the file.

## What is where

| Path | What it holds |
| --- | --- |
| `src/schema.graphql` | the SDL, every cache directive annotated with what it demonstrates |
| `gpilot.toml` | the auth providers, the private key and the two bucket entries, one client profile |
| `docs/` | one page per scenario, in reading order |
| `src/store/port.ts` | `CatalogueStore`, the storage port, and the domain types |
| `src/store/memory-store.ts` | the adapter a reader meets first |
| `src/store/durable-object-store.ts` | the adapter the deployment uses: one Durable Object over SQLite |
| `src/data/seed.ts` | 20 deterministic products, with categories, reviews and inventory |
| `src/resolvers/` | one file per type |
| `src/__tests__/cache-control-coverage.test.ts` | walks the SDL and fails on an unruled composite type or a dropped scope |
| `src/auth/` | the token endpoint, the JWKS endpoint, and the claim shapes the buckets read |
| `src/signing/` | origin signature verification, runtime agnostic |
| `src/schema.ts` | `createSchema(store)`, the executable schema |
| `src/node.ts` | the Node entry point |
| `src/worker.ts` | the Cloudflare entry point, and the only place `/admin/reset` is served |
| `wrangler.jsonc` | the Worker's configuration. JSONC, not TOML: wrangler 4 reads it first, and `wrangler types` and the Vitest pool find it there |
| `.github/workflows/deploy.yml` | Worker, then secrets, then schema and config to the edge |
| `src/type-defs.ts` | generated from the SDL with `pnpm sdl`, so the core imports no `.graphql` file |
| `Dockerfile` | one stage, for self-hosting |

The core (the schema, the resolvers, the store port, auth and signing) imports nothing
runtime-specific: no `node:` modules, no Workers globals beyond the Fetch API and WebCrypto. That
is what makes it copy-pasteable into whatever server you already run. Only the entry points know
where they are.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | the Node server, restarting on a change |
| `pnpm start` | the Node server |
| `pnpm dev:worker` | `wrangler dev`, the Worker with a local Durable Object |
| `pnpm test` | vitest, both the plain suite and the Workers pool |
| `pnpm typecheck` | `tsc --noEmit` over both tsconfigs, the worker's included |
| `pnpm lint` | biome |
| `pnpm sdl` | regenerates `src/type-defs.ts` from `src/schema.graphql` |
| `pnpm build` | `pnpm sdl`, then `pnpm typecheck` |

vitest is pinned to 4.x on purpose: `@cloudflare/vitest-plugin` has no vitest 5 support yet, and
the Workers pool is what runs the Durable Object tests. Raising it breaks that half of the suite.

## License

MIT.
