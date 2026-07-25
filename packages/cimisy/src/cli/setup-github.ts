import * as clack from "@clack/prompts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeCimisyConfigBlob } from "../env/blob.js";
import { GithubAppAuth } from "../github/app-auth-core.js";
import { CIMISY_ENV_VARS } from "../shared/github-env.js";
import { parseRepoSpec } from "../shared/repo-spec.js";
import { pathExists } from "../scan/config-detection.js";
import { formatDoctorReport, loadProjectEnv, runDoctor } from "./doctor.js";
import { gitignoreCoversEnvLocal, mergeEnvFile, parseEnvFile } from "./env-file.js";
import { buildAppManifest, manifestRegistrationUrl, suggestAppName, MAX_APP_NAME_LENGTH } from "./manifest.js";
import { exchangeManifestCode, startManifestCallbackServer, type ManifestConversion } from "./manifest-flow.js";

/**
 * `cimisy setup github` — registers a GitHub App, installs it, and hands
 * back one environment variable to paste into a deployment.
 *
 * This replaces a ~30-minute README walkthrough (register an App by hand,
 * tick three permission boxes, type a callback URL, generate and download
 * a PEM, generate a client secret, invent a session secret, set seven env
 * vars) with one browser confirmation. Every one of those manual steps was
 * a silent-failure mode; the wizard makes them a data structure instead.
 *
 * Secret handling rule for this whole file: values obtained from GitHub —
 * the PEM, the client secret — and the generated session secret exist only
 * in process memory and in `.env.local`. Nothing prints them. The single
 * exception is the deliberate `CIMISY_CONFIG` line in the handoff step,
 * which the user has to be able to copy, and which is preceded by an
 * explicit warning about what it contains.
 */

const ENV_FILE_NAME = ".env.local";

/** GitHub says a manifest code lives 1 hour; the wizard's own window is 10 minutes. */
const INSTALL_POLL_INTERVAL_MS = 3000;
const INSTALL_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export interface SetupGithubOptions {
  projectRoot: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — resolves once the App shows up as installed on the repo. */
  now?: () => number;
}

/** `openssl rand -base64 32` equivalent — the step this used to ask users to run by hand. */
export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64");
}

/** True for a syntactically usable https origin. Refuses http:// outright: the session cookie is Secure in production, so a non-TLS origin can never sign in. */
export function isValidProductionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Opens a URL in the platform browser, best-effort — the wizard always prints it too, so a failure here is not an error. */
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser launcher on this machine (CI, a bare container) — the
    // printed URL is the fallback, and it always works.
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Waits for the App to appear as installed on the target repo. Only a 404
 * counts as "not yet" — a 401 means the credentials we just received are
 * being rejected, which is a real failure and must not be polled through
 * for five minutes.
 */
async function waitForInstallation(
  appAuth: GithubAppAuth,
  owner: string,
  repo: string,
  options: { timeoutMs?: number; intervalMs?: number; signalAttempt?: (attempt: number) => void } = {},
): Promise<Awaited<ReturnType<GithubAppAuth["getRepoInstallation"]>>> {
  const timeoutMs = options.timeoutMs ?? INSTALL_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? INSTALL_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; ; attempt++) {
    options.signalAttempt?.(attempt);
    try {
      return await appAuth.getRepoInstallation(owner, repo);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for the App to be installed on ${owner}/${repo}. ` +
            `The App itself was created and your ${ENV_FILE_NAME} is written — install it from the link above and run "npx cimisy doctor" to finish.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/** Pipes the blob to `vercel env add` via stdin — never argv, which would put a private key into shell history and every process listing on the machine. */
async function runVercelEnvAdd(projectRoot: string, blob: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("vercel", ["env", "add", CIMISY_ENV_VARS.config, "production"], {
      cwd: projectRoot,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`\`vercel env add\` exited with code ${code}.`))));
    child.stdin?.end(`${blob}\n`);
  });
}

async function vercelFastPathAvailable(projectRoot: string): Promise<boolean> {
  if (!(await pathExists(path.join(projectRoot, ".vercel", "project.json")))) return false;
  return await new Promise<boolean>((resolve) => {
    const child = spawn("vercel", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function runSetupGithubCommand(options: SetupGithubOptions): Promise<void> {
  const { projectRoot } = options;
  clack.intro("cimisy setup github");

  // ── 1. Prompts ────────────────────────────────────────────────────────
  const repoAnswer = await clack.text({
    message: "Which repository will hold your content?",
    placeholder: "owner/repo",
    validate: (value) => (parseRepoSpec(value ?? "") ? undefined : 'Expected "owner/repo".'),
  });
  if (clack.isCancel(repoAnswer)) return void clack.cancel("Cancelled — nothing was created.");
  const repo = repoAnswer.trim();
  const { owner, name: repoName } = parseRepoSpec(repo)!;

  const accountKind = await clack.select({
    message: `Is "${owner}" a personal account or an organization?`,
    options: [
      { value: "user", label: "Personal account" },
      { value: "org", label: "Organization" },
    ],
  });
  if (clack.isCancel(accountKind)) return void clack.cancel("Cancelled — nothing was created.");

  const appNameAnswer = await clack.text({
    message: "Name for the GitHub App (must be unique across all of GitHub):",
    initialValue: suggestAppName(repo),
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (trimmed === "") return "An App name is required.";
      if (trimmed.length > MAX_APP_NAME_LENGTH) return `GitHub caps App names at ${MAX_APP_NAME_LENGTH} characters.`;
      return undefined;
    },
  });
  if (clack.isCancel(appNameAnswer)) return void clack.cancel("Cancelled — nothing was created.");

  const productionAnswer = await clack.text({
    message: "Production URL of your deployed app (leave blank to set this up for localhost only):",
    placeholder: "https://example.vercel.app",
    defaultValue: "",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (trimmed === "") return undefined;
      return isValidProductionOrigin(trimmed) ? undefined : "Expected a full https:// URL, e.g. https://example.vercel.app";
    },
  });
  if (clack.isCancel(productionAnswer)) return void clack.cancel("Cancelled — nothing was created.");
  const productionOrigin = productionAnswer.trim() === "" ? undefined : productionAnswer.trim();

  if (!productionOrigin) {
    clack.log.warn(
      "No production URL given, so only the localhost callback is registered. Before production sign-in works you'll need to " +
        `add "<your-url>${"/api/cimisy/auth/callback"}" to the App's callback URLs on GitHub.`,
    );
  }

  // ── 2. Temp server + browser round trip ───────────────────────────────
  const registrationUrl = manifestRegistrationUrl({ org: accountKind === "org" ? owner : undefined });
  const server = await startManifestCallbackServer({
    registrationUrl,
    buildManifest: (redirectUrl) => buildAppManifest({ appName: appNameAnswer.trim(), repo, productionOrigin, redirectUrl }),
  });

  clack.log.step(`Opening GitHub to create the App. If your browser doesn't open, visit:\n  ${server.startUrl}`);
  openBrowser(server.startUrl);

  const spinner = clack.spinner();
  spinner.start("Waiting for you to confirm the App on GitHub");

  let manifestCode: string;
  try {
    manifestCode = await server.code;
    spinner.stop("App confirmed on GitHub");
  } catch (err) {
    spinner.stop("Setup did not complete");
    await server.close();
    throw err;
  }

  // ── 3. Exchange the one-time code for credentials ─────────────────────
  spinner.start("Fetching the App's credentials");
  let conversion: ManifestConversion;
  try {
    conversion = await exchangeManifestCode(manifestCode, { fetchImpl: options.fetchImpl });
  } finally {
    // The code is single-use and short-lived; drop the only reference we
    // hold to it as soon as it has been redeemed (or failed to).
    manifestCode = "";
    await server.close();
  }
  spinner.stop(`Created GitHub App "${conversion.name}" (app id ${conversion.id})`);

  // ── 4. Assemble secrets ───────────────────────────────────────────────
  const envFilePath = path.join(projectRoot, ENV_FILE_NAME);
  const envFileExisted = await pathExists(envFilePath);
  const existingEnv = await readFileOrEmpty(envFilePath);
  const existingSessionSecret = parseEnvFile(existingEnv)[CIMISY_ENV_VARS.sessionSecret];

  // Reusing an existing secret keeps everyone's admin sessions valid
  // across a re-run; rotating it silently would log the whole team out.
  const sessionSecret = existingSessionSecret && existingSessionSecret.length >= 32 ? existingSessionSecret : generateSessionSecret();

  const configValues = {
    repo,
    branch: "main",
    appId: String(conversion.id),
    privateKey: conversion.pem,
    clientId: conversion.client_id,
    clientSecret: conversion.client_secret,
    sessionSecret,
  };

  // ── 5. Write .env.local ───────────────────────────────────────────────
  const merged = mergeEnvFile(existingEnv, {
    [CIMISY_ENV_VARS.source]: "github",
    [CIMISY_ENV_VARS.repo]: repo,
    [CIMISY_ENV_VARS.branch]: "main",
    [CIMISY_ENV_VARS.appId]: configValues.appId,
    [CIMISY_ENV_VARS.privateKey]: configValues.privateKey,
    [CIMISY_ENV_VARS.clientId]: configValues.clientId,
    [CIMISY_ENV_VARS.clientSecret]: configValues.clientSecret,
    [CIMISY_ENV_VARS.sessionSecret]: sessionSecret,
  });

  await writeFile(envFilePath, merged.content, "utf8");
  if (!envFileExisted && process.platform !== "win32") {
    // Owner-only: this file now holds an App private key.
    await chmod(envFilePath, 0o600);
  }

  clack.log.success(`${envFileExisted ? "Updated" : "Created"} ${ENV_FILE_NAME}`);
  for (const key of merged.added) clack.log.info(`  + ${key}`);
  for (const key of merged.updated) clack.log.info(`  ~ ${key} (replaced)`);
  for (const key of merged.unchanged) clack.log.info(`  = ${key} (already correct)`);
  // Said out loud rather than silently: these lines were removed from a
  // file cimisy doesn't own. They were duplicate assignments that would
  // otherwise have shadowed what was just written (.env is last-one-wins).
  for (const key of merged.removedDuplicates) {
    clack.log.warn(`  - ${key} (removed a duplicate later in the file — it would have overridden the value above)`);
  }

  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignore = await readFileOrEmpty(gitignorePath);
  if (!gitignoreCoversEnvLocal(gitignore)) {
    clack.log.warn(`${ENV_FILE_NAME} is NOT covered by .gitignore — it now contains a GitHub App private key.`);
    const addIt = await clack.confirm({ message: "Add \".env*.local\" to .gitignore?" });
    if (!clack.isCancel(addIt) && addIt) {
      const prefix = gitignore === "" || gitignore.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, `${gitignore}${prefix}\n# Local env files (contains secrets)\n.env*.local\n`, "utf8");
      clack.log.success("Added .env*.local to .gitignore");
    } else {
      clack.log.warn("Left .gitignore alone — do NOT commit .env.local.");
    }
  }

  // ── 6. Install the App on the repo ────────────────────────────────────
  const installUrl = `https://github.com/apps/${conversion.slug}/installations/new`;
  clack.log.step(`Now install the App on ${repo}:\n  ${installUrl}`);
  openBrowser(installUrl);

  const appAuth = new GithubAppAuth({
    appId: configValues.appId,
    privateKey: configValues.privateKey,
    clientId: configValues.clientId,
    clientSecret: configValues.clientSecret,
  });

  spinner.start(`Waiting for the App to be installed on ${repo}`);
  const installation = await waitForInstallation(appAuth, owner, repoName, {
    signalAttempt: (attempt) => spinner.message(`Waiting for the App to be installed on ${repo} (check ${attempt})`),
  });
  spinner.stop(`Installed on ${repo}`);

  spinner.start("Verifying repository access");
  const octokit = await appAuth.getInstallationClient(owner, repoName);
  await octokit.rest.repos.get({ owner, repo: repoName });

  // Collaborator-permission lookup is what cimisy's RBAC maps to a role,
  // so proving the installation can perform it now beats discovering at
  // first sign-in that it can't. An organization account is never its own
  // collaborator, so a miss there is informational, not a failure.
  const accountLogin = installation.account?.login ?? owner;
  let permissionLevel: string | null = null;
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo: repoName, username: accountLogin });
    permissionLevel = data.permission;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  spinner.stop(
    permissionLevel
      ? `Repository access verified (${accountLogin}: ${permissionLevel})`
      : `Repository access verified (no collaborator entry for "${accountLogin}" — expected for an organization account)`,
  );

  // ── 7. Deployment handoff ─────────────────────────────────────────────
  const blob = encodeCimisyConfigBlob(configValues);

  clack.log.step("Deployment: set one environment variable.");
  console.log("");
  console.log(`  ⚠  The line below contains your App private key, client secret, and session secret.`);
  console.log(`     Paste it into your deployment platform only — never into an issue, a PR, or a chat.`);
  console.log("");
  console.log(`${CIMISY_ENV_VARS.config}=${blob}`);
  console.log("");

  if (await vercelFastPathAvailable(projectRoot)) {
    const useVercel = await clack.confirm({
      message: `Set ${CIMISY_ENV_VARS.config} on this Vercel project now (production environment)?`,
    });
    if (!clack.isCancel(useVercel) && useVercel) {
      try {
        await runVercelEnvAdd(projectRoot, blob);
        clack.log.success(`Set ${CIMISY_ENV_VARS.config} on Vercel (production).`);
      } catch (err) {
        clack.log.warn(`Could not set it via the Vercel CLI (${err instanceof Error ? err.message : String(err)}). Set it manually — see below.`);
      }
    }
  }

  clack.log.info(
    [
      "Setting it manually:",
      `  Vercel   Project → Settings → Environment Variables → add ${CIMISY_ENV_VARS.config}`,
      `  Netlify  netlify env:set ${CIMISY_ENV_VARS.config} "<the value above>"`,
      `  Anywhere set ${CIMISY_ENV_VARS.config} to the value above — that one variable is the whole config.`,
    ].join("\n"),
  );
  clack.log.info(
    `Then redeploy (env vars only take effect on a new build) and sign in at ${productionOrigin ? `${productionOrigin}/admin` : "<your-url>/admin"}.`,
  );

  // ── 8. Doctor finale ──────────────────────────────────────────────────
  // The same checks and the same format `npx cimisy doctor` prints, so
  // there's exactly one answer to "is this configured correctly?".
  spinner.start("Verifying the setup");
  const report = await runDoctor({ projectRoot, env: await loadProjectEnv(projectRoot) });
  spinner.stop(report.ok ? "Verified" : "Verification found problems");
  console.log("");
  console.log(formatDoctorReport(report));
  console.log("");

  if (!report.ok) {
    clack.outro(`Some checks failed — fix them and re-run "npx cimisy doctor".`);
    process.exitCode = 1;
    return;
  }

  clack.outro(`Done. Locally: start your dev server and open http://localhost:3000/admin.`);
}
