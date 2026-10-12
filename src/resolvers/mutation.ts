import type { ReviewDraft } from "../store/port.ts";
import type { StoreFor } from "./index.ts";

/** The writes exist so a purge has something to prove. Each one changes what the very next read
 * returns, which is what makes "the cached answer is stale until it is purged" demonstrable. */
export function mutationResolvers(storeFor: StoreFor) {
    return {
        setPrice: (_root: unknown, args: { id: string; price: number }, context: unknown) =>
            storeFor(context).setPrice(args.id, args.price),

        addReview: (_root: unknown, args: { input: ReviewDraft }, context: unknown) =>
            storeFor(context).addReview(args.input),

        reserveStock: (_root: unknown, args: { id: string; count: number }, context: unknown) =>
            storeFor(context).reserveStock(args.id, args.count),

        renameCategory: (_root: unknown, args: { id: string; name: string }, context: unknown) =>
            storeFor(context).renameCategory(args.id, args.name),
    };
}
