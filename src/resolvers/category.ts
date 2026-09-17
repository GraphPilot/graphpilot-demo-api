import type { CatalogueStore, Category } from "../store/port.ts";

/** The list `@cacheControl(inheritMaxAge: true)` sits on: it keeps the category's long lifetime
 * instead of capping it at the product's. */
export function categoryResolvers(store: CatalogueStore) {
    return {
        products: (category: Category) => store.products(category.id),
    };
}
