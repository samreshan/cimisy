"use client";

import { useEffect, useState } from "react";
import type { AdminManifest } from "../../next/manifest.js";
import { ADMIN_THEME_CSS } from "../admin-theme.js";
import { type MeResponse, apiUrl, logout } from "./api.js";
import { ContentTree, EntryList } from "./collections.js";
import { DraftsPage } from "./drafts.js";
import { EntryForm } from "./entry-form.js";
import { TopNav } from "./nav.js";
import { SingletonForm } from "./singleton-form.js";
import { TeamPage } from "./team.js";
import { THEME_BOOTSTRAP_SCRIPT } from "./theme.js";

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
    // suppressHydrationWarning: the bootstrap script below sets data-theme on this exact element
    // before React hydrates, which is by design (see THEME_BOOTSTRAP_SCRIPT's doc comment) — without
    // this, React treats the server/client attribute difference as a hydration error and logs it.
    <div className="cimisy-root" suppressHydrationWarning>
      {/* Runs first, synchronously, so data-theme lands on this element before it paints —
          see theme.tsx's THEME_BOOTSTRAP_SCRIPT doc comment for why ordering matters here. */}
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
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
            contentKey={segments[0]}
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
  // Dotted content keys ("home.hero") are a single URL segment, so the
  // two-segment [key, slug] routing survives the hierarchy unchanged.
  const [contentKey, slug] = segments;

  if (!contentKey) {
    return <ContentTree manifest={manifest} basePath={basePath} />;
  }
  // Reserved before content-key routing, the same way "new" is reserved at
  // the slug level below — config() rejects content keys named "team",
  // "drafts", "pages", or "new" so these can't shadow real content.
  if (contentKey === "team") {
    return <TeamPage basePath={basePath} apiBasePath={apiBasePath} isAdmin={role === "admin"} />;
  }
  if (contentKey === "drafts") {
    return <DraftsPage manifest={manifest} basePath={basePath} apiBasePath={apiBasePath} />;
  }
  const entity = manifest.byKey[contentKey];
  if (!entity) {
    return <p>Unknown content &quot;{contentKey}&quot;</p>;
  }
  if (entity.kind === "singleton") {
    return <SingletonForm singleton={entity} basePath={basePath} apiBasePath={apiBasePath} />;
  }
  if (!slug) {
    return <EntryList collection={entity} basePath={basePath} apiBasePath={apiBasePath} />;
  }
  return (
    <EntryForm
      collection={entity}
      slug={slug === "new" ? null : slug}
      basePath={basePath}
      apiBasePath={apiBasePath}
    />
  );
}
