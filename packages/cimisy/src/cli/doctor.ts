import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSourceEnv, type EnvRecord, type GithubSourceEnvOptions } from "../env/read-env.js";
import { GithubAppAuth } from "../github/app-auth-core.js";
import { detectSource, pathExists, resolveConfigFilePath } from "../scan/config-detection.js";
import { CIMISY_ENV_VARS } from "../shared/github-env.js";
import { parseRepoSpec } from "../shared/repo-spec.js";
import { parseEnvFile } from "./env-file.js";
import { isProjectSetUp } from "./setup-project.js";

/**
 * `cimisy doctor` — answers "is this project actually configured, and will
 * it work?" as a checklist rather than as a 500 at first sign-in.
 *
 * Every failure mode this reports was, before v2.5, something you found out
 * about from a stack trace in a deploy log: a var set under a name cimisy
 * doesn't read, a PEM that lost its newlines in a dashboard text field, an
 * App that was created but never installed, an installation whose Contents
 * permission was silently declined. Each check names the fix.
 *
 * Also the wizard's final step, so `setup github` and a standalone `doctor`
 * run report identically — one implementation, one format.
 */

export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  /** Stable machine-readable id — the --json contract. */
  id: string;
  label: string;
  status: DoctorStatus;
  /** What was found. Never contains a secret value. */
  detail?: string;
  /** What to do about it, when it isn't a pass. */
  fix?: string;
}

export interface DoctorReport {
  /** True when no check failed. Warnings do not make a report not-ok. */
  ok: boolean;
  /** Which source the environment resolves to — "unresolved" when the env itself is malformed. */
  mode: "local" | "github" | "unresolved";
  checks: DoctorCheck[];
}

/** The GitHub round trips doctor makes, behind an interface so tests can drive checks 2 and 3 without a network or a real App. */
export interface GithubProbe {
  appMetadata(): Promise<{ slug: string | null; name: string }>;
  repoInstallation(owner: string, repo: string): Promise<{ id: number; permissions: Record<string, string>; account: { login: string; type: string } | null }>;
  branchExists(owner: string, repo: string, branch: string): Promise<boolean>;
  collaboratorPermission(owner: string, repo: string, username: string): Promise<string | null>;
}

export interface RunDoctorOptions {
  projectRoot: string;
  /** Defaults to the project's `.env`/`.env.local` layered under process.env. */
  env?: EnvRecord;
  /** Defaults to a real GithubAppAuth-backed probe. */
  createProbe?: (credentials: GithubSourceEnvOptions) => GithubProbe;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Layers the project's env files the way Next.js does — `.env`, then
 * `.env.local`, then the real process environment on top. Without this,
 * doctor run in a plain terminal would report every var as missing even
 * though `next dev` finds them all, which would be worse than useless.
 */
export async function loadProjectEnv(projectRoot: string, baseEnv: EnvRecord = process.env): Promise<EnvRecord> {
  const layers: EnvRecord[] = [];
  for (const fileName of [".env", ".env.local"]) {
    try {
      layers.push(parseEnvFile(await readFile(path.join(projectRoot, fileName), "utf8")));
    } catch {
      // Absent or unreadable — that's the ordinary case, not an error.
    }
  }
  return Object.assign({}, ...layers, baseEnv) as EnvRecord;
}

/** Wraps GithubAppAuth so all real App JWT / installation-token work stays in the one audited place. */
export function createDefaultProbe(credentials: GithubSourceEnvOptions): GithubProbe {
  const appAuth = new GithubAppAuth(credentials);
  return {
    async appMetadata() {
      const metadata = await appAuth.getAppMetadata();
      return { slug: metadata.slug, name: metadata.name };
    },
    repoInstallation: (owner, repo) => appAuth.getRepoInstallation(owner, repo),
    async branchExists(owner, repo, branch) {
      const octokit = await appAuth.getInstallationClient(owner, repo);
      try {
        await octokit.rest.repos.getBranch({ owner, repo, branch });
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
    async collaboratorPermission(owner, repo, username) {
      const octokit = await appAuth.getInstallationClient(owner, repo);
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
        return data.permission;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}

/**
 * Checks 1 and 5 — everything answerable from the environment alone, with
 * no network and no filesystem. Split out because it's the part with real
 * branching, and because the wizard and the CLI both need it to decide
 * whether the GitHub checks are even worth attempting.
 */
export function checkEnvironment(env: EnvRecord): { checks: DoctorCheck[]; mode: DoctorReport["mode"]; options?: GithubSourceEnvOptions } {
  const checks: DoctorCheck[] = [];

  let resolution;
  try {
    resolution = readSourceEnv(env);
  } catch (err) {
    checks.push({
      id: "env.resolve",
      label: "Environment resolves to a source",
      status: "fail",
      detail: errorMessage(err),
      fix: `Re-run "npx cimisy setup github" to print a fresh ${CIMISY_ENV_VARS.config}.`,
    });
    return { checks, mode: "unresolved" };
  }

  if (resolution.mode === "local") {
    checks.push({
      id: "env.resolve",
      label: "Environment resolves to a source",
      status: "pass",
      detail: `local adapter${resolution.allowInProduction ? ` (${CIMISY_ENV_VARS.allowLocalProd}=true)` : ""}`,
    });
    checks.push({
      id: "env.github",
      label: "GitHub source configured",
      status: "skip",
      detail: `${CIMISY_ENV_VARS.source} is not "github" and ${CIMISY_ENV_VARS.config} is unset`,
      fix: `Run "npx cimisy setup github" when you're ready to deploy. Local development needs nothing further.`,
    });
    return { checks, mode: "local" };
  }

  checks.push({
    id: "env.resolve",
    label: "Environment resolves to a source",
    status: "pass",
    detail: `GitHub adapter, configured via ${resolution.origin === "blob" ? CIMISY_ENV_VARS.config : "individual CIMISY_* variables"}`,
  });

  for (const warning of resolution.warnings) {
    checks.push({ id: "env.precedence", label: "Configuration form", status: "warn", detail: warning });
  }

  if (!resolution.options) {
    checks.push({
      id: "env.github",
      label: "GitHub source configured",
      status: "fail",
      detail: `missing: ${resolution.missing.join(", ")}`,
      fix: `Run "npx cimisy setup github" to create the App and write these, or set ${CIMISY_ENV_VARS.config} to the blob it prints.`,
    });
    return { checks, mode: "github" };
  }

  const options = resolution.options;
  checks.push({ id: "env.github", label: "GitHub source configured", status: "pass", detail: `${options.repo} @ ${options.branch}` });

  checks.push(
    options.sessionSecret.length >= 32
      ? { id: "env.sessionSecret", label: "Session secret is long enough", status: "pass", detail: `${options.sessionSecret.length} characters` }
      : {
          id: "env.sessionSecret",
          label: "Session secret is long enough",
          status: "fail",
          // The length is reported; the value never is.
          detail: `${CIMISY_ENV_VARS.sessionSecret} is ${options.sessionSecret.length} characters, minimum is 32`,
          fix: "Generate one with `openssl rand -base64 32` — a short secret signing the session cookie is brute-forceable.",
        },
  );

  try {
    // A real parse, not a shape check: the common failure is a PEM whose
    // newlines a hosting dashboard ate, which still looks like a PEM.
    createPrivateKey(options.privateKey);
    checks.push({ id: "env.privateKey", label: "App private key parses", status: "pass" });
  } catch (err) {
    checks.push({
      id: "env.privateKey",
      label: "App private key parses",
      status: "fail",
      detail: errorMessage(err),
      fix:
        `${CIMISY_ENV_VARS.privateKey} is not a readable PEM — usually its newlines were lost. ` +
        `Store it \\n-escaped on one line, or use ${CIMISY_ENV_VARS.config}, which carries it safely.`,
    });
  }

  // Not a failure: cimisy ships a working in-memory limiter. But on
  // serverless that limiter is per-instance, which quietly means "no
  // effective rate limit" — worth saying out loud exactly once.
  const hasSharedStore = ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_URL"].some((name) => (env[name] ?? "").trim() !== "");
  checks.push(
    hasSharedStore
      ? { id: "env.rateLimiter", label: "Shared rate-limit store available", status: "pass" }
      : {
          id: "env.rateLimiter",
          label: "Shared rate-limit store available",
          status: "warn",
          detail: "no Upstash/Vercel KV/Redis variables found — the default rate limiter is in-memory",
          fix: "On serverless each instance gets its own bucket, so the limit isn't really enforced. Pass your own `rateLimiter` in cimisy.config backed by shared storage.",
        },
  );

  return { checks, mode: "github", options };
}

/** Checks 2 and 3 — the GitHub round trips. Each failure is reported and the rest still run where they can, so one run tells you everything that's wrong. */
async function checkGithub(probe: GithubProbe, options: GithubSourceEnvOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const repo = parseRepoSpec(options.repo);
  if (!repo) {
    return [
      {
        id: "github.repo",
        label: "Repository name is well-formed",
        status: "fail",
        detail: `"${options.repo}" is not "owner/repo"`,
        fix: `Set ${CIMISY_ENV_VARS.repo} to "owner/repo".`,
      },
    ];
  }

  try {
    const app = await probe.appMetadata();
    checks.push({ id: "github.appAuth", label: "App credentials accepted by GitHub", status: "pass", detail: app.slug ?? app.name });
  } catch (err) {
    checks.push({
      id: "github.appAuth",
      label: "App credentials accepted by GitHub",
      status: "fail",
      detail: errorMessage(err),
      fix: `GitHub rejected an App JWT signed with this key. Check ${CIMISY_ENV_VARS.appId} matches the App the private key belongs to.`,
    });
    // Nothing below can work without App auth — stop rather than emit a
    // cascade of failures that all have the same one cause.
    return checks;
  }

  let installation: Awaited<ReturnType<GithubProbe["repoInstallation"]>>;
  try {
    installation = await probe.repoInstallation(repo.owner, repo.name);
    checks.push({ id: "github.installation", label: "App is installed on the repository", status: "pass", detail: `installation ${installation.id}` });
  } catch (err) {
    checks.push({
      id: "github.installation",
      label: "App is installed on the repository",
      status: "fail",
      detail: isNotFound(err) ? `no installation found on ${options.repo}` : errorMessage(err),
      fix: "Install the App on the repo from its GitHub App settings page (\"Install App\" in the sidebar).",
    });
    return checks;
  }

  // Permissions are *requested* by the manifest but *granted* by whoever
  // installs — an installer can decline, and the first symptom would
  // otherwise be a 403 on someone's first save.
  for (const [permission, required, label] of [
    ["contents", "write", "Contents: write granted"],
    ["pull_requests", "write", "Pull requests: write granted"],
  ] as const) {
    const granted = installation.permissions[permission];
    checks.push(
      granted === required
        ? { id: `github.permission.${permission}`, label, status: "pass" }
        : {
            id: `github.permission.${permission}`,
            label,
            status: "fail",
            detail: `granted "${granted ?? "none"}", need "${required}"`,
            fix: "Update the App's repository permissions on GitHub, then accept the permission-change request on the installation.",
          },
    );
  }

  try {
    const exists = await probe.branchExists(repo.owner, repo.name, options.branch);
    checks.push(
      exists
        ? { id: "github.branch", label: "Branch exists", status: "pass", detail: options.branch }
        : {
            id: "github.branch",
            label: "Branch exists",
            status: "fail",
            detail: `${options.repo} has no branch "${options.branch}"`,
            fix: `Set ${CIMISY_ENV_VARS.branch} to the repo's real default branch (or push at least one commit — an empty repo has no branch to read).`,
          },
    );
  } catch (err) {
    checks.push({ id: "github.branch", label: "Branch exists", status: "fail", detail: errorMessage(err) });
  }

  // What cimisy's RBAC maps to a role. An organization is never its own
  // collaborator, so "no entry" there is expected, not broken.
  const accountLogin = installation.account?.login ?? repo.owner;
  const isOrg = installation.account?.type === "Organization";
  try {
    const permission = await probe.collaboratorPermission(repo.owner, repo.name, accountLogin);
    checks.push(
      permission
        ? { id: "github.collaborator", label: "Collaborator permission lookup works", status: "pass", detail: `${accountLogin}: ${permission}` }
        : {
            id: "github.collaborator",
            label: "Collaborator permission lookup works",
            status: isOrg ? "pass" : "warn",
            detail: `no collaborator entry for "${accountLogin}"${isOrg ? " (expected for an organization account)" : ""}`,
            fix: isOrg ? undefined : "Signing in as a non-collaborator is rejected by design — add the account as a collaborator on the repo.",
          },
    );
  } catch (err) {
    checks.push({
      id: "github.collaborator",
      label: "Collaborator permission lookup works",
      status: "fail",
      detail: errorMessage(err),
      fix: "cimisy resolves every user's role through this lookup, so sign-in cannot work until it does.",
    });
  }

  return checks;
}

/** Check 4 — is cimisy actually mounted in this Next.js app? */
async function checkProjectWiring(projectRoot: string, mode: DoctorReport["mode"]): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const configFilePath = await resolveConfigFilePath(projectRoot);
  const configExists = await pathExists(configFilePath);
  if (!configExists) {
    checks.push({
      id: "project.config",
      label: "cimisy.config found",
      status: "fail",
      detail: `no config file at ${path.relative(projectRoot, configFilePath)}`,
      fix: 'Run "npx cimisy setup" to scaffold it.',
    });
  } else {
    // Deliberately static, never executed — the CLI does not run a
    // consumer's arbitrary TypeScript (see scan/config-detection.ts). So
    // this reports which adapter the config *wires*, not the result of
    // loading it.
    const detection = detectSource(await readFile(configFilePath, "utf8"), configFilePath);
    // An env-driven config isn't "local" — it's whatever the environment
    // selects, which the env checks above already reported. Saying "local"
    // here would contradict them on a correctly-configured GitHub deploy.
    const sourceDescription =
      detection.kind !== "local"
        ? detection.kind
        : detection.envDriven
          ? `resolveSourceFromEnv, content in ${detection.rootDir}`
          : `local, ${detection.rootDir}`;
    checks.push({
      id: "project.config",
      label: "cimisy.config found",
      status: "pass",
      detail: `${path.relative(projectRoot, configFilePath)} (source: ${sourceDescription})`,
    });

    // A config that calls githubSource(...) directly throws at *import*
    // when its env vars are absent, which fails the whole build rather
    // than one request — worth flagging before a deploy discovers it.
    if (detection.kind === "github" && mode !== "github") {
      checks.push({
        id: "project.sourceMismatch",
        label: "Config's source matches the environment",
        status: "warn",
        detail: "the config calls githubSource(...) but the environment resolves to the local adapter",
        fix:
          `githubSource throws at config import when its credentials are missing, so this build would fail. ` +
          `Switch the config to resolveSourceFromEnv({ contentDir }) from "cimisy/env", or set ${CIMISY_ENV_VARS.config}.`,
      });
    }
  }

  const setUp = await isProjectSetUp(projectRoot);
  checks.push(
    setUp
      ? { id: "project.routes", label: "Admin page and API route mounted", status: "pass" }
      : {
          id: "project.routes",
          label: "Admin page and API route mounted",
          status: "fail",
          detail: "the /admin page and/or the /api/cimisy route handler are missing",
          fix: 'Run "npx cimisy setup" to scaffold them (it never overwrites existing files).',
        },
  );

  return checks;
}

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? (await loadProjectEnv(options.projectRoot));
  const environment = checkEnvironment(env);
  const checks = [...environment.checks];

  if (environment.options) {
    const probe = (options.createProbe ?? createDefaultProbe)(environment.options);
    checks.push(...(await checkGithub(probe, environment.options)));
  }

  checks.push(...(await checkProjectWiring(options.projectRoot, environment.mode)));

  return { ok: !checks.some((check) => check.status === "fail"), mode: environment.mode, checks };
}

const STATUS_MARK: Record<DoctorStatus, string> = { pass: "✔", fail: "✖", warn: "!", skip: "–" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => {
    const head = `${STATUS_MARK[check.status]} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`;
    // A fix hint on a passing check is noise; on anything else it's the
    // whole point of running this.
    return check.status === "pass" || !check.fix ? head : `${head}\n    → ${check.fix}`;
  });

  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  const summary = failed > 0 ? `${failed} check${failed === 1 ? "" : "s"} failed` : warned > 0 ? `All checks passed (${warned} warning${warned === 1 ? "" : "s"})` : "All checks passed";

  return [...lines, "", summary].join("\n");
}

/** 0 all pass, 1 any failure. Usage errors (exit 2) are raised as CliUsageError by the caller, never reported through here. */
export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? 0 : 1;
}
