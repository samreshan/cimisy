import { useEffect, useState } from "react";
import { type RosterUserLike, apiUrl } from "./api.js";

/** Mirrors config/define-config.ts's DEFAULT_ROLES — the assignable role names an admin can grant from the Team screen. A project with fully custom `roles` can still assign anything by name; this list is just the common-case default. */
const ASSIGNABLE_ROLES = ["admin", "publisher", "editor", "viewer"];

/** Lists every user who has ever signed in (see rbac/user-store.ts) and lets an admin assign/change/revoke their role. The server re-checks admin permission on every GET/POST — `isAdmin` here only decides whether to render the inline "not an admin" notice versus attempting the fetch (which would 403 anyway). */
export function TeamPage({ basePath, apiBasePath, isAdmin }: { basePath: string; apiBasePath: string; isAdmin: boolean }) {
  const [users, setUsers] = useState<RosterUserLike[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch(apiUrl(apiBasePath, "/users"))
      .then(async (res) => {
        const data = (await res.json()) as { users?: RosterUserLike[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Failed to load team.");
          return;
        }
        setUsers(data.users ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load team.");
      });
    return () => {
      cancelled = true;
    };
  }, [apiBasePath, isAdmin]);

  async function handleRoleChange(githubId: string, role: string) {
    setError(null);
    setSavingId(githubId);
    const res = await fetch(apiUrl(apiBasePath, "/users"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubId, role: role === "" ? null : role }),
    });
    const data = (await res.json()) as { users?: RosterUserLike[]; error?: string };
    setSavingId(null);
    if (!res.ok) {
      setError(data.error ?? "Failed to update role.");
      return;
    }
    setUsers(data.users ?? []);
  }

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Content
      </a>
      <h1 className="cimisy-heading">Team</h1>
      {!isAdmin ? (
        <p className="cimisy-banner cimisy-banner-danger">Only admins can manage the team.</p>
      ) : (
        <>
          {error && (
            <p className="cimisy-banner cimisy-banner-danger" role="alert">
              {error}
            </p>
          )}
          {users === null ? (
            <div className="cimisy-skeleton-stack" role="status" aria-label="Loading team">
              <div className="cimisy-skeleton cimisy-skeleton-card" />
              <div className="cimisy-skeleton cimisy-skeleton-card" />
            </div>
          ) : users.length === 0 ? (
            <p className="cimisy-empty">No one has signed in yet.</p>
          ) : (
            <ul className="cimisy-list">
              {users.map((u) => (
                <li key={u.githubId}>
                  <div className="cimisy-card cimisy-team-card">
                    <div>
                      <div className="cimisy-team-name">{u.name ?? u.githubLogin}</div>
                      <div className="cimisy-muted" style={{ fontSize: "0.85em" }}>
                        @{u.githubLogin}
                      </div>
                    </div>
                    <select
                      className="cimisy-select"
                      style={{ width: "auto" }}
                      value={u.role ?? ""}
                      disabled={savingId === u.githubId}
                      onChange={(e) => handleRoleChange(u.githubId, e.target.value)}
                    >
                      <option value="">— pending —</option>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
