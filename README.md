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

**This is a demo.** The data is in memory, the deployed Worker has a `POST /admin/reset` endpoint
that throws it away and reseeds, and the demo mints its own tokens for anyone who asks. None of
those three belongs in a real API. Everything else here is meant to be copied.

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

Node 26 or newer, which runs the TypeScript sources directly. No build step.

Signature verification guards `/graphql` and is on by default, so it will refuse everything you
send by hand, because nothing local is signing. `REQUIRE_SIGNATURE=false pnpm start` turns it off
for local work, with a warning on every request while it is off. Do not set it anywhere real. The
other routes are unsigned on purpose, and
[docs/15-origin-signature.md](docs/15-origin-signature.md) has the table saying which and why.

A local run generates a key pair at startup, so restarting invalidates every token it had minted.
That is fine locally and is not fine deployed: see the environment table below.

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

   | Variable | Why it matters |
   | --- | --- |
   | `SIGNING_KEY` | the signing key GraphPilot issued for the service. Until the origin holds it, the edge's own requests are refused with a 401 exactly as your own were. Required unless `REQUIRE_SIGNATURE=false`. |
   | `AUTH_PRIVATE_JWK` | the RS256 key the demo signs tokens with. **Set this or the deployment is quietly broken:** without it, every cold start generates a fresh key pair, so tokens minted before it stop verifying and GraphPilot's cached copy of the key set stops matching. It logs a warning when it falls back, which a serverless runtime makes easy to miss. |
   | `ADMIN_TOKEN` | the fallback guard on `POST /admin/reset`, used where signatures are off. |
   | `REQUIRE_SIGNATURE` | leave it unset. `false` serves unverified requests and says so on every one. |

   `AUTH_PRIVATE_JWK` and `jwks_url` are two halves of one key: rotate the first and redeploy, or
   the edge keeps verifying against a key set the origin no longer signs with.

6. **Walk the docs.** Export `EDGE`, `ORIGIN` and `SERVICE` as [docs/README.md](docs/README.md)
   describes, and start at page 1.

## What is where

| Path | What it holds |
| --- | --- |
| `src/schema.graphql` | the SDL, every cache directive annotated with what it demonstrates |
| `gpilot.toml` | the auth providers, the private key and the two bucket entries, one client profile |
| `docs/` | one page per scenario, in reading order |
| `src/store/port.ts` | `CatalogueStore`, the storage port, and the domain types |
| `src/store/memory-store.ts` | the adapter a reader meets first |
| `src/data/seed.ts` | 20 deterministic products, with categories, reviews and inventory |
| `src/resolvers/` | one file per type |
| `src/auth/` | the token endpoint, the JWKS endpoint, and the claim shapes the buckets read |
| `src/signing/` | origin signature verification, runtime agnostic |
| `src/schema.ts` | `createSchema(store)`, the executable schema |
| `src/node.ts` | the Node entry point |
| `src/type-defs.ts` | generated from the SDL with `pnpm sdl`, so the core imports no `.graphql` file |
| `Dockerfile` | one stage, for self-hosting |

The core (the schema, the resolvers, the store port, auth and signing) imports nothing
runtime-specific: no `node:` modules, no Workers globals beyond the Fetch API and WebCrypto. That
is what makes it copy-pasteable into whatever server you already run. Only the entry points know
where they are.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | the server, restarting on a change |
| `pnpm start` | the server |
| `pnpm test` | vitest |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | biome |
| `pnpm sdl` | regenerates `src/type-defs.ts` from `src/schema.graphql` |
| `pnpm build` | `pnpm sdl`, then `pnpm typecheck` |

## License

MIT.
