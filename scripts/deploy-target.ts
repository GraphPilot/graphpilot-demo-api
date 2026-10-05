/**
 * The two things the deploy workflow does before it touches anything, kept out of YAML so they
 * are tested (`src/__tests__/deploy-target.test.ts`).
 *
 * The demo deploys twice from one workflow: the production demo, and the stage platform's demo.
 * Both legs read secrets and variables under the same names, and GitHub resolves a name the
 * stage environment does not define from the repository. A stage leg missing GPILOT_API_URL
 * would hand the CLI no URL, and the CLI defaults to production: the stage leg would publish its
 * schema to the production demo service with whatever token it found. So the stage leg proves it
 * is configured as stage before it deploys anything.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PRODUCTION_API_HOST = "api.graphpilot.io";
export const STAGE_DEMO_HOST_SUFFIX = ".stage.graphpilot.cloud";

export interface DeployTarget {
    /** The GitHub environment this leg runs in: `production` or `stage`. */
    readonly environment: string;
    /** `vars.DEPLOY_TARGET`, defined on the stage environment only, never on the repository. */
    readonly declaredTarget: string;
    /** `vars.GPILOT_API_URL`. Empty on production, where the CLI's default is the right one. */
    readonly apiUrl: string;
    /** `vars.DEMO_JWKS_URL`, the stage demo's own key set. */
    readonly jwksUrl: string;
}

function hostOf(value: string): string | undefined {
    try {
        return new URL(value).host;
    } catch {
        return undefined;
    }
}

/** Every reason this leg must not deploy. An empty list means it may. */
export function deployTargetProblems(target: DeployTarget): string[] {
    if (target.environment === "production") {
        if (target.apiUrl !== "" && hostOf(target.apiUrl) !== PRODUCTION_API_HOST) {
            return [
                `GPILOT_API_URL is ${target.apiUrl} on the production leg; leave it unset or point it at ${PRODUCTION_API_HOST}`,
            ];
        }
        return [];
    }
    if (target.environment !== "stage") {
        return [`unknown environment "${target.environment}", expected production or stage`];
    }

    const problems: string[] = [];
    if (target.declaredTarget !== "stage") {
        problems.push(
            `DEPLOY_TARGET is "${target.declaredTarget}" on the stage leg; set it to "stage" on the stage environment, never on the repository`,
        );
    }
    const apiHost = hostOf(target.apiUrl);
    if (apiHost === undefined) {
        problems.push(
            "GPILOT_API_URL is unset or not a URL on the stage leg; without it the CLI deploys to production",
        );
    } else if (apiHost === PRODUCTION_API_HOST) {
        problems.push(`GPILOT_API_URL points at ${PRODUCTION_API_HOST} on the stage leg`);
    }
    const jwksHost = hostOf(target.jwksUrl);
    if (jwksHost === undefined || !jwksHost.endsWith(STAGE_DEMO_HOST_SUFFIX)) {
        problems.push(
            `DEMO_JWKS_URL must be the stage demo's key set (*${STAGE_DEMO_HOST_SUFFIX}), got "${target.jwksUrl}"`,
        );
    }
    return problems;
}

/** `gpilot.toml` with the demo provider's `jwks_url` replaced. Refuses anything but exactly one. */
export function renderGpilotConfig(toml: string, jwksUrl: string): string {
    const pattern = /^jwks_url = ".*"$/gm;
    const found = toml.match(pattern)?.length ?? 0;
    if (found !== 1) {
        throw new Error(`expected exactly one jwks_url line in gpilot.toml, found ${found}`);
    }
    return toml.replace(pattern, `jwks_url = "${jwksUrl}"`);
}

function main(argv: readonly string[]): void {
    const [command, input, output] = argv;
    const env = process.env;

    if (command === "check") {
        const problems = deployTargetProblems({
            environment: env.TARGET_ENVIRONMENT ?? "",
            declaredTarget: env.DEPLOY_TARGET ?? "",
            apiUrl: env.GPILOT_API_URL ?? "",
            jwksUrl: env.DEMO_JWKS_URL ?? "",
        });
        for (const problem of problems) {
            console.error(`::error::${problem}`);
        }
        if (problems.length > 0) {
            process.exit(1);
        }
        console.log(`deploy target ${env.TARGET_ENVIRONMENT} checked`);
        return;
    }

    if (command === "render" && input !== undefined && output !== undefined) {
        writeFileSync(
            output,
            renderGpilotConfig(readFileSync(input, "utf8"), env.DEMO_JWKS_URL ?? ""),
        );
        return;
    }

    console.error("usage: node scripts/deploy-target.ts check | render <in> <out>");
    process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
