/**
 * The one field in this schema that never resolves.
 *
 * It takes no store, because it reads nothing: failing is the whole behaviour. It is a resolver
 * rather than a `null` in the data, and the difference matters. A null is an answer, and the edge
 * stores an answer; a throw produces an `errors` array beside whatever else resolved, and that is
 * the shape the edge refuses to store. Returning null here would demonstrate the opposite of what
 * this field is for.
 */

/** What `Query.faulty` hands down. `broken` is absent: the resolver below produces it, by failing. */
export interface FaultAnswer {
    nonce: string;
    observedAt: string;
}

export function faultResolvers() {
    return {
        // The message names the field, because it ends up in the customer-visible `errors` array
        // and in the portal's GraphQL tab, where "Error" on its own would send a reader looking for
        // a defect that is not there.
        broken: (root: FaultAnswer): never => {
            throw new Error(
                `Fault.broken always fails: it exists so the edge's handling of an erroring origin ` +
                    `can be observed (nonce ${root.nonce})`,
            );
        },
    };
}
