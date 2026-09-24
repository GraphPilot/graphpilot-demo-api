import type { ActivityEntry, CatalogueStore, Product } from "../store/port.ts";
import { deliberateFailure, type FaultAnswer } from "./fault.ts";
import type { DemoContext } from "./index.ts";
import type { Viewer } from "./me.ts";

/** The feed plus the moment the origin produced it. The wrapper exists for `observedAt`: a stale
 * answer and a fresh one are otherwise identical whenever nothing has been written. */
interface Activity {
    observedAt: string;
    entries: ActivityEntry[];
}

type ReportRange = "DAY" | "WEEK" | "MONTH";

interface Report extends Viewer {
    range: ReportRange;
    revenue: number;
    orders: number;
    generatedAt: string;
}

/** What an unauthenticated caller counts as. It is a value rather than null so `reports` stays
 * non-null and the anonymous bucket is a bucket like any other. */
const ANONYMOUS = "anonymous";

export function queryResolvers(store: CatalogueStore) {
    return {
        products: async (
            _root: unknown,
            args: { category?: string | null; first?: number | null; after?: string | null },
        ): Promise<Product[]> => {
            const all = await store.products(args.category ?? undefined);
            const start = args.after ? all.findIndex((p) => p.id === args.after) + 1 : 0;
            return all.slice(start, start + (args.first ?? 20));
        },

        product: (_root: unknown, args: { id: string }) => store.product(args.id),

        categories: () => store.categories(),

        search: (_root: unknown, args: { term: string }) => store.search(args.term),

        // `observedAt` is stamped here, in the resolver, and nowhere else. That is what makes a
        // stale answer legible from the outside: an entry served past its five seconds carries the
        // timestamp of the run that produced it, so an unchanged `observedAt` proves the origin was
        // not reached, and a changed one proves it was.
        activity: async (_root: unknown, args: { first?: number | null }): Promise<Activity> => ({
            observedAt: new Date().toISOString(),
            entries: await store.activity(args.first ?? 5),
        }),

        me: (_root: unknown, _args: unknown, context: DemoContext): Viewer | null => {
            const claims = context.claims;
            if (!claims) {
                return null;
            }
            return { id: claims.sub, organizationId: claims.org_id, role: claims.role };
        },

        // Deterministic numbers derived from the bucket, so a shared entry is visible as one: two
        // callers in the same organization and role get byte-identical answers, a third with
        // another role does not.
        reports: (
            _root: unknown,
            args: { range?: ReportRange | null },
            context: DemoContext,
        ): Report => {
            const range = args.range ?? "DAY";
            const organizationId = context.claims?.org_id ?? ANONYMOUS;
            const role = context.claims?.role ?? ANONYMOUS;
            const days = range === "DAY" ? 1 : range === "WEEK" ? 7 : 30;
            const orders = days * 11;
            return {
                id: context.claims?.sub ?? ANONYMOUS,
                range,
                organizationId,
                role,
                orders,
                revenue: orders * 2_499,
                generatedAt: new Date().toISOString(),
            };
        },

        // The only field that is never stored, and therefore the one that proves a response came
        // from the origin rather than from the edge.
        now: () => new Date().toISOString(),

        // Fails on request. `fail: true` throws here, so the response carries errors and no data;
        // leaving it false and selecting `Fault.broken` instead leaves this answer standing beside
        // the error it produces. Both are refused by the edge, and the second is the one worth
        // looking at, because it is the one that still contains usable data.
        //
        // `observedAt` is stamped here for the same reason `activity` stamps its own: it is the
        // only evidence that separates an answer the origin produced from one the edge had already.
        faulty: (_root: unknown, args: { nonce: string; fail: boolean }): FaultAnswer => {
            if (args.fail) {
                throw deliberateFailure(
                    `Query.faulty was asked to fail (nonce ${args.nonce}): it exists so the edge's ` +
                        `handling of an erroring origin can be observed`,
                );
            }
            return { nonce: args.nonce, observedAt: new Date().toISOString() };
        },
    };
}
