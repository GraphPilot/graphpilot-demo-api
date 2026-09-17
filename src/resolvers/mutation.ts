import type { CatalogueStore, ReviewDraft } from "../store/port.ts";

/** The writes exist so a purge has something to prove. Each one changes what the very next read
 * returns, which is what makes "the cached answer is stale until it is purged" demonstrable. */
export function mutationResolvers(store: CatalogueStore) {
    return {
        setPrice: (_root: unknown, args: { id: string; price: number }) =>
            store.setPrice(args.id, args.price),

        addReview: (_root: unknown, args: { input: ReviewDraft }) => store.addReview(args.input),

        reserveStock: (_root: unknown, args: { id: string; count: number }) =>
            store.reserveStock(args.id, args.count),

        renameCategory: (_root: unknown, args: { id: string; name: string }) =>
            store.renameCategory(args.id, args.name),
    };
}
