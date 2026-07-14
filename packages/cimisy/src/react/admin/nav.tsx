import { type MeResponse, logout } from "./api.js";
import { ThemeToggle } from "./theme.js";

/** "Mira Kaur" -> "MK", "cimisy" -> "CI" — a stable, deterministic stand-in for an avatar photo the admin UI has no way to fetch (auth only gives us a name/email, no GitHub avatar URL). */
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

export function TopNav({
  user,
  role,
  basePath,
  apiBasePath,
  draftsSupported,
  contentKey,
}: {
  user: MeResponse["user"];
  role?: string | null;
  basePath: string;
  apiBasePath: string;
  draftsSupported: boolean;
  /** First URL segment under basePath, if any — used only to highlight the active tab. */
  contentKey?: string;
}) {
  return (
    <nav className="cimisy-nav">
      <a className="cimisy-nav-brand-link" href={basePath}>
        cimisy
      </a>
      <div className="cimisy-nav-links">
        <a
          className={`cimisy-nav-link ${contentKey !== "team" && contentKey !== "drafts" ? "is-active" : ""}`}
          href={basePath}
        >
          Content
        </a>
        {draftsSupported && (
          <a className={`cimisy-nav-link ${contentKey === "drafts" ? "is-active" : ""}`} href={`${basePath}/drafts`}>
            Drafts
          </a>
        )}
        {role === "admin" && (
          <a className={`cimisy-nav-link ${contentKey === "team" ? "is-active" : ""}`} href={`${basePath}/team`}>
            Team
          </a>
        )}
      </div>
      <div className="cimisy-nav-user">
        <ThemeToggle />
        {user && (
          <span className="cimisy-avatar" title={user.name}>
            {initialsFor(user.name)}
          </span>
        )}
        {role && <span className="cimisy-badge">{role}</span>}
        <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => logout(apiBasePath)}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
