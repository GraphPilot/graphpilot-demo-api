import { type CatalogueStore, type Category, NotFoundError, type Product } from "../store/port.ts";

/** `category`, `inventory` and `reviews` are separate reads, so the `@cacheControl` hints on them
 * have something to apply to: the short-lived `inventory` caps a response the rest of which could
 * have lived an hour. */
export function productResolvers(store: CatalogueStore) {
    return {
        category: async (product: Product): Promise<Category> => {
            const category = await store.category(product.categoryId);
            if (!category) {
                throw new NotFoundError("Category", product.categoryId);
            }
            return category;
        },
        inventory: (product: Product) => store.inventory(product.id),
        reviews: (product: Product) => store.reviews(product.id),
    };
}
