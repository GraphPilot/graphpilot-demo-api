/**
 * The one field in this schema that never resolves.
 *
 * It takes no store, because it reads nothing: failing is the whole behaviour. It is a resolver
 * rather than a `null` in the data, and the difference matters. A null is an answer, and the edge
 * stores an answer; a throw produces an `errors` array beside whatever else resolved, and that is
 * the shape the edge refuses to store. Returning null here would demonstrate the opposite of what
 * this field is for.
 */

import { GraphQLError } from "graphql";

/**
 * Thrown rather than a plain `Error`, and that is not decoration.
 *
 * Yoga masks anything that is not a `GraphQLError` down to "Unexpected error." before it reaches a
 * client, which is the right default for a real API and useless here. This field exists to be read:
 * the message ends up in the customer's `errors` array and in the portal's GraphQL tab, and a demo
 * that showed "Unexpected error." there would teach nothing about either.
 */
export function deliberateFailure(message: string): GraphQLError {
    return new GraphQLError(message, { extensions: { code: "DEMO_DELIBERATE_FAILURE" } });
}

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
            throw deliberateFailure(
                `Fault.broken always fails: it exists so the edge's handling of an erroring origin ` +
                    `can be observed (nonce ${root.nonce})`,
            );
        },
    };
}
