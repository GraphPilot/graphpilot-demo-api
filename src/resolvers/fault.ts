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

/** What `Query.keyedFault` hands down. `failKey` travels on the parent because the field that acts
 * on it takes no arguments of its own: the edge injects `brokenId` for its key, and an injected
 * field is written by the edge, so nothing the client sends can reach it except through here. */
export interface KeyedFaultAnswer {
    nonce: string;
    observedAt: string;
    failKey: boolean;
    nullKey: boolean;
}

export function keyedFaultResolvers() {
    return {
        // Derived from the nonce rather than random, so the surrogate key on the answer is one a
        // reader can predict and purge by hand: `KeyedFault:brokenId:keyed-<nonce>`.
        brokenId: (root: KeyedFaultAnswer): string | null => {
            if (root.nullKey && !root.failKey) {
                // The quiet case. No error, nothing in the answer to notice, and the edge still has
                // a key to build from a value that is not there. What it writes then is the whole
                // question, because a purge aimed at that key is a purge a customer believes worked.
                return null;
            }
            if (root.failKey) {
                throw deliberateFailure(
                    `KeyedFault.brokenId was asked to fail (nonce ${root.nonce}): it is the field ` +
                        `the edge injects to build this type's surrogate key, so the error names a ` +
                        `field the client never selected`,
                );
            }
            return `keyed-${root.nonce}`;
        },
    };
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
