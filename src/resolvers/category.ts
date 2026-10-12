import type { Category } from "../store/port.ts";
import type { StoreFor } from "./index.ts";

/** The list `@cacheControl(inheritMaxAge: true)` sits on: it keeps the category's long lifetime
 * instead of capping it at the product's. */
export function categoryResolvers(storeFor: StoreFor) {
    return {
        products: (category: Category, _args: unknown, context: unknown) =>
            storeFor(context).products(category.id),
    };
}
