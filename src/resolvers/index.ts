import type { CatalogueStore } from "../store/port.ts";
import { categoryResolvers } from "./category.ts";
import { meResolvers } from "./me.ts";
import { mutationResolvers } from "./mutation.ts";
import { productResolvers } from "./product.ts";
import { queryResolvers } from "./query.ts";

/**
 * The claims the edge's bucket configuration reads off a verified token. `src/auth/` mints them;
 * until it exists, the entry points pass null and everything identity-bound answers as anonymous.
 */
export interface Claims {
    sub: string;
    org_id: string;
    role: string;
}

/** Everything a resolver may read off the request. The store is not here: it is bound at schema
 * construction, so a resolver cannot accidentally be handed a different one mid-request. */
export interface DemoContext {
    claims?: Claims | null;
}

export function createResolvers(store: CatalogueStore) {
    return {
        Query: queryResolvers(store),
        Mutation: mutationResolvers(store),
        Product: productResolvers(store),
        Category: categoryResolvers(store),
        Me: meResolvers(store),
    };
}
