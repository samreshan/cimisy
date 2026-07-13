import { type MeResponse, logout } from "./api.js";

export function TopNav({
  user,
  role,
  basePath,
  apiBasePath,
  draftsSupported,
}: {
  user: MeResponse["user"];
  role?: string | null;
  basePath: string;
  apiBasePath: string;
  draftsSupported: boolean;
}) {
  return (
    <nav className="cimisy-nav">
      <a className="cimisy-nav-brand-link" href={basePath}>
        cimisy
      </a>
      <div className="cimisy-nav-links">
        <a className="cimisy-nav-link" href={basePath}>
          Content
        </a>
        {draftsSupported && (
          <a className="cimisy-nav-link" href={`${basePath}/drafts`}>
            Drafts
          </a>
        )}
        {role === "admin" && (
          <a className="cimisy-nav-link" href={`${basePath}/team`}>
            Team
          </a>
        )}
      </div>
      <div className="cimisy-nav-user">
        {user && <span>{user.name}</span>}
        {role && <span className="cimisy-badge">{role}</span>}
        <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => logout(apiBasePath)}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
