import type { Catalogue, Category, Inventory, Product, Review } from "../store/port.ts";

/**
 * A deterministic catalogue: same ids, same prices, same timestamps on every run and in every
 * runtime. A system test that asserts "the answer did not change within its lifetime" needs the
 * origin to be boring, so nothing here reads a clock or a random number.
 */

/** The fixed point every seeded timestamp is derived from. */
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

const CATEGORIES: Category[] = [
    { id: "audio", name: "Audio" },
    { id: "desks", name: "Desks" },
    { id: "lighting", name: "Lighting" },
    { id: "storage", name: "Storage" },
];

const PRODUCT_NAMES = [
    "Studio Monitor",
    "Field Recorder",
    "Ribbon Microphone",
    "Headphone Amplifier",
    "Mixing Console",
    "Standing Desk",
    "Walnut Worktop",
    "Cable Tray",
    "Monitor Arm",
    "Desk Mat",
    "Task Lamp",
    "Edge Lit Panel",
    "Warm Bulb",
    "Dimmer Switch",
    "Clamp Light",
    "Shelf Unit",
    "Archive Box",
    "Drawer Insert",
    "Pegboard",
    "Cable Drum",
] as const;

/** Which category each product belongs to, five per category, in order. */
function categoryOf(index: number): string {
    const category = CATEGORIES[Math.floor(index / 5)];
    if (!category) {
        throw new Error(`no category for product index ${index}`);
    }
    return category.id;
}

/** Deterministic and readable: prices climb, ratings cycle through a fixed set. */
function priceOf(index: number): number {
    return 1900 + index * 750;
}

function ratingOf(index: number): number {
    return 3.5 + (index % 4) * 0.375;
}

function isoAt(offsetDays: number): string {
    return new Date(EPOCH + offsetDays * 86_400_000).toISOString();
}

export function seed(): Catalogue {
    const products: Product[] = PRODUCT_NAMES.map((name, index) => ({
        id: `p${String(index + 1).padStart(2, "0")}`,
        name,
        price: priceOf(index),
        rating: ratingOf(index),
        categoryId: categoryOf(index),
        updatedAt: isoAt(index),
    }));

    // One review on every third product, so a reader sees both the populated and the empty case.
    const reviews: Review[] = products
        .filter((_, index) => index % 3 === 0)
        .map((product, index) => ({
            id: `r${String(index + 1).padStart(2, "0")}`,
            productId: product.id,
            author: `reviewer-${index + 1}`,
            body: `A steady performer, ${product.name.toLowerCase()} does what it says.`,
            rating: 3 + (index % 3),
            createdAt: isoAt(index * 2),
        }));

    const inventory: Inventory[] = products.map((product, index) => ({
        productId: product.id,
        available: 10 + index,
        reservedAt: null,
    }));

    return {
        products,
        categories: CATEGORIES.map((category) => ({ ...category })),
        reviews,
        inventory,
    };
}
