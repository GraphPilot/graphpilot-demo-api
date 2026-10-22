import type { Claims } from "../auth/claims.ts";
import type { CatalogueStore } from "../store/port.ts";
import { forRequest } from "../store/request-scoped-store.ts";
import { categoryResolvers } from "./category.ts";
import { faultResolvers, keyedFaultResolvers } from "./fault.ts";
import { libraryQueryResolvers } from "./library.ts";
import { meResolvers } from "./me.ts";
import { mutationResolvers } from "./mutation.ts";
import { productResolvers } from "./product.ts";
import { queryResolvers } from "./query.ts";

/**
 * The claims the edge's bucket configuration reads off a verified token. `src/auth/` owns the
 * definition and mints them; re-exported here so a resolver reads its context from one place.
 */
export type { Claims };

/** Everything a resolver may read off the request. The store is not here: it is bound at schema
 * construction, so a resolver cannot accidentally be handed a different one mid-request. What a
 * resolver does get per request is that store's memo, through `StoreFor`. */
export interface DemoContext {
    claims?: Claims | null;
}

/**
 * The store for the request a resolver is resolving, looked up by its context. Every resolver that
 * reads goes through it, so one request asks the store each distinct question once. See
 * `src/store/request-scoped-store.ts` for why that matters on Workers and what keeps it consistent.
 */
export type StoreFor = (context: unknown) => CatalogueStore;

export function createResolvers(store: CatalogueStore) {
    const storeFor = forRequest(store);
    return {
        Query: { ...queryResolvers(storeFor), ...libraryQueryResolvers() },
        Mutation: mutationResolvers(storeFor),
        Product: productResolvers(storeFor),
        Category: categoryResolvers(storeFor),
        Me: meResolvers(storeFor),
        Fault: faultResolvers(),
        KeyedFault: keyedFaultResolvers(),
    };
}
