// Turns `src/schema.graphql` into `src/type-defs.ts`, a plain module the core can import.
//
// The SDL stays the file a reader opens. The generated module exists because the core imports
// nothing runtime-specific: Node cannot import a `.graphql` file at run time and a Worker needs a
// bundler rule for it, while a `.ts` module works everywhere without either.
//
// `src/__tests__/type-defs.test.ts` fails when the two drift apart.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function render(sdl) {
    // The SDL quotes argument names in backticks, so the three things a template literal reads as
    // syntax are escaped rather than refused.
    const escaped = sdl
        .trimEnd()
        .replaceAll("\\", "\\\\")
        .replaceAll("`", "\\`")
        .replaceAll("${", "\\${");

    return [
        "// Generated from src/schema.graphql by scripts/generate-type-defs.mjs. Do not edit.",
        "",
        `export const typeDefs = \`\n${escaped}\n\`;`,
        "",
    ].join("\n");
}

export function readSdl() {
    return readFileSync(join(root, "src/schema.graphql"), "utf8");
}

export function typeDefsPath() {
    return join(root, "src/type-defs.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    writeFileSync(typeDefsPath(), render(readSdl()));
}
