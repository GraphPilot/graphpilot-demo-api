# GraphPilot demo API

A small GraphQL product catalogue whose only job is to show what every GraphPilot edge caching
feature does. Read `src/schema.graphql` and you have read the whole story: each directive carries
a one-line comment saying what it demonstrates.

## Run it

```sh
corepack pnpm@9.15.0 install
pnpm start
```

The server listens on `http://localhost:4000`:

- `POST /graphql` and `GET /graphql` (GraphiQL in a browser)
- `GET /health`

## What is here

| Path | What it holds |
| --- | --- |
| `src/schema.graphql` | the SDL, every cache directive annotated |
| `src/store/port.ts` | `CatalogueStore`, the storage port |
| `src/store/memory-store.ts` | the adapter a reader meets first |
| `src/data/seed.ts` | 20 deterministic products, with categories, reviews and inventory |
| `src/resolvers/` | one file per type |
| `src/schema.ts` | `createSchema(store)`, the executable schema |
| `src/node.ts` | the Node entry point |
| `src/type-defs.ts` | generated from the SDL with `pnpm sdl`, so the core imports no `.graphql` file |

Node 26 or newer, which runs the TypeScript sources directly. No build step.

## Not here yet

Token and JWKS endpoints (`src/auth/`), origin signature verification (`src/signing/`), the
Cloudflare Worker entry point (`src/worker.ts`), `gpilot.toml` and the scenario docs. Those land
in the following steps.

## License

MIT.
