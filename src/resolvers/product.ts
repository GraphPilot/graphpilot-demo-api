import { type Category, NotFoundError, type Product } from "../store/port.ts";
import type { StoreFor } from "./index.ts";

/** `category`, `inventory` and `reviews` are separate reads, so the `@cacheControl` hints on them
 * have something to apply to: the short-lived `inventory` caps a response the rest of which could
 * have lived an hour. */
export function productResolvers(storeFor: StoreFor) {
    return {
        category: async (product: Product, _args: unknown, context: unknown): Promise<Category> => {
            const category = await storeFor(context).category(product.categoryId);
            if (!category) {
                throw new NotFoundError("Category", product.categoryId);
            }
            return category;
        },
        inventory: (product: Product, _args: unknown, context: unknown) =>
            storeFor(context).inventory(product.id),
        reviews: (product: Product, _args: unknown, context: unknown) =>
            storeFor(context).reviews(product.id),
    };
}
