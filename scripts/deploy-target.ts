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
 *
 * Secrets fall back the same way, so the stage leg reads its own names (`STAGE_SIGNING_KEY`,
 * `GPILOT_STAGE_TOKEN`) that the repository never defines: a missing one stays empty and is
 * refused here, rather than resolving to production's value. `ORIGIN_URL` is a repository
 * variable too, so a stage leg would otherwise health-check the production Worker.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PRODUCTION_API_HOST = "api.graphpilot.io";
/** The only API host the stage leg may publish to. A positive match, so nothing else slips by. */
export const STAGE_API_HOST = "api.stage.graphpilot.io";
/** The `wrangler.jsonc` environment that names the stage Worker. */
export const STAGE_WRANGLER_ENV = "stage";
export const STAGE_DEMO_HOST_SUFFIX = ".stage.graphpilot.cloud";
/** The stage Worker's name in `wrangler.jsonc`, and so the first label of its workers.dev host. */
export const STAGE_WORKER_NAME = "graphpilot-demo-api-stage";

export interface DeployTarget {
    /** The GitHub environment this leg runs in: `production` or `stage`. */
    readonly environment: string;
    /**
     * The workflow's `wrangler-env` input: empty for the top-level (production) Worker, `stage`
     * for the stage Worker. Checked so a leg can never write its secrets into the other Worker.
     */
    readonly wranglerEnv: string;
    /** `vars.DEPLOY_TARGET`, defined on the stage environment only, never on the repository. */
    readonly declaredTarget: string;
    /** `vars.GPILOT_API_URL`. Empty on production, where the CLI's default is the right one. */
    readonly apiUrl: string;
    /** `vars.DEMO_JWKS_URL`, the stage demo's own key set. */
    readonly jwksUrl: string;
    /** `vars.ORIGIN_URL`. Empty skips the health gate; on stage it must be the stage Worker. */
    readonly originUrl: string;
    /** Whether `secrets.STAGE_SIGNING_KEY` is non-empty. Only the stage leg reads it. */
    readonly stageSigningKeySet: boolean;
    /** Whether `secrets.GPILOT_STAGE_TOKEN` is non-empty. Only the stage leg reads it. */
    readonly stageDeployTokenSet: boolean;
}

function urlOf(value: string): URL | undefined {
    try {
        return new URL(value);
    } catch {
        return undefined;
    }
}

function hostOf(value: string): string | undefined {
    return urlOf(value)?.host;
}

/** Every reason this leg must not deploy. An empty list means it may. */
export function deployTargetProblems(target: DeployTarget): string[] {
    if (target.environment === "production") {
        const problems: string[] = [];
        if (target.wranglerEnv !== "") {
            problems.push(
                `the production leg runs with wrangler env "${target.wranglerEnv}"; it must deploy the top-level Worker (no wrangler env)`,
            );
        }
        if (target.apiUrl !== "" && hostOf(target.apiUrl) !== PRODUCTION_API_HOST) {
            problems.push(
                `GPILOT_API_URL is ${target.apiUrl} on the production leg; leave it unset or point it at ${PRODUCTION_API_HOST}`,
            );
        }
        return problems;
    }
    if (target.environment !== "stage") {
        return [`unknown environment "${target.environment}", expected production or stage`];
    }

    const problems: string[] = [];
    if (target.wranglerEnv !== STAGE_WRANGLER_ENV) {
        problems.push(
            `the stage leg runs with wrangler env "${target.wranglerEnv}"; it must be "${STAGE_WRANGLER_ENV}", or its secrets land in the production Worker`,
        );
    }
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
    } else if (apiHost !== STAGE_API_HOST) {
        problems.push(
            `GPILOT_API_URL points at ${apiHost} on the stage leg; it must be exactly ${STAGE_API_HOST}`,
        );
    }
    const jwksHost = hostOf(target.jwksUrl);
    if (jwksHost === undefined || !jwksHost.endsWith(STAGE_DEMO_HOST_SUFFIX)) {
        problems.push(
            `DEMO_JWKS_URL must be the stage demo's key set (*${STAGE_DEMO_HOST_SUFFIX}), got "${target.jwksUrl}"`,
        );
    }
    if (target.originUrl !== "") {
        const originLabel = urlOf(target.originUrl)?.hostname.split(".")[0];
        if (originLabel !== STAGE_WORKER_NAME) {
            problems.push(
                `ORIGIN_URL is "${target.originUrl}" on the stage leg; it must be the stage Worker (https://${STAGE_WORKER_NAME}.<subdomain>.workers.dev), set on the stage environment`,
            );
        }
    }
    if (!target.stageSigningKeySet) {
        problems.push(
            "STAGE_SIGNING_KEY is unset on the stage leg; set it on the stage environment to the stage service's signing key",
        );
    }
    if (!target.stageDeployTokenSet) {
        problems.push(
            "GPILOT_STAGE_TOKEN is unset on the stage leg; set it on the stage environment to a stage API key that may deploy demo-api",
        );
    }
    return problems;
}

/**
 * `gpilot.toml` with the demo provider's `jwks_url` replaced. Refuses anything but exactly one,
 * and a replacement that is not a URL.
 */
export function renderGpilotConfig(toml: string, jwksUrl: string): string {
    if (urlOf(jwksUrl) === undefined) {
        throw new Error(`DEMO_JWKS_URL "${jwksUrl}" is not a URL`);
    }
    const pattern = /^jwks_url = ".*"$/gm;
    const found = toml.match(pattern)?.length ?? 0;
    if (found !== 1) {
        throw new Error(`expected exactly one jwks_url line in gpilot.toml, found ${found}`);
    }
    // A replacer function, so `$&`, `$1` or `$$` in the URL are written as they are.
    return toml.replace(pattern, () => `jwks_url = "${jwksUrl}"`);
}

function main(argv: readonly string[]): void {
    const [command, input, output] = argv;
    const env = process.env;

    if (command === "check") {
        const problems = deployTargetProblems({
            environment: env.TARGET_ENVIRONMENT ?? "",
            wranglerEnv: env.WRANGLER_ENV ?? "",
            declaredTarget: env.DEPLOY_TARGET ?? "",
            apiUrl: env.GPILOT_API_URL ?? "",
            jwksUrl: env.DEMO_JWKS_URL ?? "",
            originUrl: env.ORIGIN_URL ?? "",
            stageSigningKeySet: env.STAGE_SIGNING_KEY_SET === "true",
            stageDeployTokenSet: env.GPILOT_STAGE_TOKEN_SET === "true",
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
