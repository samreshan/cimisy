/**
 * The path cimisy's API route handler serves the GitHub OAuth callback at,
 * relative to an app origin. Lives in shared/ because three unrelated
 * surfaces have to agree on it exactly — the setup wizard's App manifest,
 * the unconfigured-deployment instructions page, and the README — and a
 * mismatch between any two of them is an unexplainable sign-in failure.
 */
export const AUTH_CALLBACK_PATH = "/api/cimisy/auth/callback";
