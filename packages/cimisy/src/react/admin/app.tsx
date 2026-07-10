"use client";

import { useEffect, useState } from "react";
import type { AdminManifest } from "../../next/manifest.js";
import { ADMIN_THEME_CSS } from "../admin-theme.js";
import { type MeResponse, apiUrl, logout } from "./api.js";
import { CollectionList, EntryList } from "./collections.js";
import { DraftsPage } from "./drafts.js";
import { EntryForm } from "./entry-form.js";
import { TopNav } from "./nav.js";
import { TeamPage } from "./team.js";

export interface AdminAppProps {
  manifest: AdminManifest;
  segments: string[];
  basePath: string;
  apiBasePath: string;
}

export function AdminApp({ manifest, segments, basePath, apiBasePath }: AdminAppProps) {
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, "/auth/me"))
      .then((res) => res.json())
      .then((data: MeResponse) => {
        if (!cancelled) setMe(data);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBasePath]);

  return (
    <div className="cimisy-root">
      {/* dangerouslySetInnerHTML, not a text child: <style> is RAWTEXT in HTML parsing (like
          <script>), so the browser never decodes entities in it, but React's default text-child
          rendering HTML-escapes quotes regardless — causing a server/client hydration mismatch
          the moment the CSS contains a quote character (e.g. in font-family). This bypasses that
          escaping entirely, matching how the browser actually parses the tag. */}
      <style dangerouslySetInnerHTML={{ __html: ADMIN_THEME_CSS }} />
      {me === null ? (
        <p className="cimisy-muted">Loading…</p>
      ) : !me.authenticated ? (
        <SignInGate apiBasePath={apiBasePath} />
      ) : me.pending ? (
        <PendingGate user={me.user} apiBasePath={apiBasePath} />
      ) : (
        <>
          <TopNav
            user={me.user}
            role={me.role}
            basePath={basePath}
            apiBasePath={apiBasePath}
            draftsSupported={manifest.draftsSupported}
          />
          <AdminRoutes
            manifest={manifest}
            segments={segments}
            basePath={basePath}
            apiBasePath={apiBasePath}
            role={me.role}
          />
        </>
      )}
    </div>
  );
}

function SignInGate({ apiBasePath }: { apiBasePath: string }) {
  return (
    <div className="cimisy-signin">
      <h1 className="cimisy-heading">cimisy admin</h1>
      <a className="cimisy-btn cimisy-btn-primary" href={`${apiBasePath}/auth/login`}>
        Sign in with GitHub &rarr;
      </a>
    </div>
  );
}

/** Shown once a GitHub sign-in has registered a user record but no admin has assigned them a role yet (see rbac/user-store.ts's ensureUserRecord) — a distinct, calm state from "not signed in", not an error. */
function PendingGate({ user, apiBasePath }: { user: MeResponse["user"]; apiBasePath: string }) {
  return (
    <div className="cimisy-signin">
      <h1 className="cimisy-heading">Waiting for access</h1>
      <p className="cimisy-muted">
        You&apos;re signed in as <strong>{user?.name}</strong>, but no admin has granted you a role yet. Ask an
        existing admin to add you from the Team screen.
      </p>
      <button
        type="button"
        className="cimisy-btn cimisy-btn-secondary"
        onClick={() => logout(apiBasePath)}
        style={{ marginTop: 20 }}
      >
        Sign out
      </button>
    </div>
  );
}

function AdminRoutes({
  manifest,
  segments,
  basePath,
  apiBasePath,
  role,
}: AdminAppProps & { role?: string | null }) {
  const [collectionName, slug] = segments;

  if (!collectionName) {
    return <CollectionList manifest={manifest} basePath={basePath} />;
  }
  // Reserved before collection-name routing, the same way "new" is reserved
  // at the slug level below — a project collection literally named "team"
  // or "drafts" would collide with this, same accepted tradeoff as "new".
  if (collectionName === "team") {
    return <TeamPage basePath={basePath} apiBasePath={apiBasePath} isAdmin={role === "admin"} />;
  }
  if (collectionName === "drafts") {
    return <DraftsPage manifest={manifest} basePath={basePath} apiBasePath={apiBasePath} />;
  }
  const collectionDef = manifest.collections.find((c) => c.name === collectionName);
  if (!collectionDef) {
    return <p>Unknown collection &quot;{collectionName}&quot;</p>;
  }
  if (!slug) {
    return <EntryList collection={collectionDef} basePath={basePath} apiBasePath={apiBasePath} />;
  }
  return (
    <EntryForm
      collection={collectionDef}
      slug={slug === "new" ? null : slug}
      basePath={basePath}
      apiBasePath={apiBasePath}
    />
  );
}
