import type { GraphQLSchema } from "graphql";
import { createSchema as makeExecutableSchema } from "graphql-yoga";
import { createResolvers, type DemoContext } from "./resolvers/index.ts";
import type { CatalogueStore } from "./store/port.ts";
import { typeDefs } from "./type-defs.ts";

/**
 * The executable schema, bound to one store.
 *
 * The directives survive into the built schema untouched: `gpilot deploy` publishes this SDL to the
 * edge, and the edge is the only thing that acts on them. Nothing in this repo reads `@cacheControl`
 * or `@surrogateKey` at run time, which is the point worth noticing.
 */
export function createSchema(store: CatalogueStore): GraphQLSchema {
    return makeExecutableSchema<DemoContext>({
        typeDefs,
        resolvers: createResolvers(store),
    });
}
