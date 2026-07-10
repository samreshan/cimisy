/**
 * Shared data shapes for the admin API responses, plus a couple of thin
 * fetch helpers to cut down on repeated `${apiBasePath}${path}` string
 * building across the admin/* components. Kept intentionally minimal —
 * each screen still owns its own request/response handling logic (loading
 * states, error surfacing) rather than funneling everything through one
 * generic data-fetching abstraction.
 */

export interface MeResponse {
  authenticated: boolean;
  user?: { id: string; name: string; email: string };
  role?: string | null;
  pending?: boolean;
}

export interface EntrySummaryLike {
  slug: string;
  version: string;
  values: Record<string, unknown>;
  error?: string;
}

export interface RosterUserLike {
  githubId: string;
  githubLogin: string;
  name: string | null;
  role: string | null;
  addedAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PublishResult {
  status: "direct" | "draft";
  branch?: string;
  pullRequestUrl?: string;
}

export interface HistoryEntryLike {
  version: string;
  message: string;
  author: { name: string; email: string };
  date: string;
}

export function apiUrl(apiBasePath: string, path: string): string {
  return `${apiBasePath}${path}`;
}

export async function apiFetchJson<T>(apiBasePath: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(apiBasePath, path), init);
  return (await res.json()) as T;
}

export async function logout(apiBasePath: string): Promise<void> {
  await fetch(apiUrl(apiBasePath, "/auth/logout"), { method: "POST" });
  window.location.reload();
}
