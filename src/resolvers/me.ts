import type { CatalogueStore, Product } from "../store/port.ts";

/** The viewer, as the resolvers pass it around: the three claims, nothing else. */
export interface Viewer {
    id: string;
    organizationId: string;
    role: string;
}

/** Deterministic per subject, so two tokens provably see two different answers and a test can say
 * which. No clock, no randomness: a private entry that changed on its own would be indistinguishable
 * from one that was not shared. */
export function meResolvers(store: CatalogueStore) {
    return {
        favourites: async (viewer: Viewer): Promise<Product[]> => {
            const products = await store.products();
            const offset = fingerprint(viewer.id) % products.length;
            return [0, 1, 2].map(
                (step) => products[(offset + step * 5) % products.length] as Product,
            );
        },
    };
}

/** A small stable hash of the subject. Not a security boundary, just a spread. */
function fingerprint(value: string): number {
    let hash = 0;
    for (const character of value) {
        hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100_003;
    }
    return hash;
}
