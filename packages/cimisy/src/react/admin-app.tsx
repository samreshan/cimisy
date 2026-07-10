"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { AdminManifest, BlockTypeManifest, CollectionManifest, FieldManifest } from "../next/manifest.js";
import { ADMIN_THEME_CSS } from "./admin-theme.js";

interface BlockNodeLike {
  type: string;
  id: string;
  props: Record<string, unknown>;
}

interface EntrySummaryLike {
  slug: string;
  version: string;
  values: Record<string, unknown>;
  error?: string;
}

interface MeResponse {
  authenticated: boolean;
  user?: { id: string; name: string; email: string };
  role?: string | null;
  pending?: boolean;
}

interface RosterUserLike {
  githubId: string;
  githubLogin: string;
  name: string | null;
  role: string | null;
  addedAt: string;
  updatedAt: string;
  updatedBy: string;
}

/** Mirrors config/define-config.ts's DEFAULT_ROLES — the assignable role names an admin can grant from the Team screen. A project with fully custom `roles` can still assign anything by name; this list is just the common-case default. */
const ASSIGNABLE_ROLES = ["admin", "publisher", "editor", "viewer"];

interface PublishResult {
  status: "direct" | "draft";
  branch?: string;
  pullRequestUrl?: string;
}

function buildPreviewUrl(apiBasePath: string, collectionName: string, slug: string, previewPath: string): string {
  const redirectTo = previewPath.replace(":slug", encodeURIComponent(slug));
  const params = new URLSearchParams({ collection: collectionName, slug, redirectTo });
  return `${apiBasePath}/preview/enable?${params.toString()}`;
}

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
    fetch(`${apiBasePath}/auth/me`)
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
          <TopNav user={me.user} role={me.role} basePath={basePath} apiBasePath={apiBasePath} />
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
  async function handleLogout() {
    await fetch(`${apiBasePath}/auth/logout`, { method: "POST" });
    window.location.reload();
  }
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
        onClick={handleLogout}
        style={{ marginTop: 20 }}
      >
        Sign out
      </button>
    </div>
  );
}

function TopNav({
  user,
  role,
  basePath,
  apiBasePath,
}: {
  user: MeResponse["user"];
  role?: string | null;
  basePath: string;
  apiBasePath: string;
}) {
  async function handleLogout() {
    await fetch(`${apiBasePath}/auth/logout`, { method: "POST" });
    window.location.reload();
  }
  return (
    <nav className="cimisy-nav">
      <a className="cimisy-nav-brand-link" href={basePath}>
        cimisy
      </a>
      <div className="cimisy-nav-links">
        <a className="cimisy-nav-link" href={basePath}>
          Collections
        </a>
        {role === "admin" && (
          <a className="cimisy-nav-link" href={`${basePath}/team`}>
            Team
          </a>
        )}
      </div>
      <div className="cimisy-nav-user">
        {user && <span>{user.name}</span>}
        {role && <span className="cimisy-badge">{role}</span>}
        <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </nav>
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
  // would collide with this, same accepted tradeoff as "new".
  if (collectionName === "team") {
    return <TeamPage basePath={basePath} apiBasePath={apiBasePath} isAdmin={role === "admin"} />;
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

function CollectionList({ manifest, basePath }: { manifest: AdminManifest; basePath: string }) {
  return (
    <div>
      <h1 className="cimisy-heading">cimisy admin</h1>
      <ul className="cimisy-list">
        {manifest.collections.map((c) => (
          <li key={c.name}>
            <a className="cimisy-card" href={`${basePath}/${c.name}`}>
              {c.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lists every user who has ever signed in (see rbac/user-store.ts) and lets an admin assign/change/revoke their role. The server re-checks admin permission on every GET/POST — `isAdmin` here only decides whether to render the inline "not an admin" notice versus attempting the fetch (which would 403 anyway). */
function TeamPage({ basePath, apiBasePath, isAdmin }: { basePath: string; apiBasePath: string; isAdmin: boolean }) {
  const [users, setUsers] = useState<RosterUserLike[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch(`${apiBasePath}/users`)
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
    const res = await fetch(`${apiBasePath}/users`, {
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
        &larr; Collections
      </a>
      <h1 className="cimisy-heading">Team</h1>
      {!isAdmin ? (
        <p className="cimisy-banner cimisy-banner-danger">Only admins can manage the team.</p>
      ) : (
        <>
          {error && <p className="cimisy-banner cimisy-banner-danger">{error}</p>}
          {users === null ? (
            <p className="cimisy-muted">Loading…</p>
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

function EntryList({
  collection,
  basePath,
  apiBasePath,
}: {
  collection: CollectionManifest;
  basePath: string;
  apiBasePath: string;
}) {
  const [entries, setEntries] = useState<EntrySummaryLike[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBasePath}/collections/${collection.name}`)
      .then((res) => res.json())
      .then((data: { entries: EntrySummaryLike[] }) => {
        if (!cancelled) setEntries(data.entries);
      });
    return () => {
      cancelled = true;
    };
  }, [collection.name, apiBasePath]);

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Collections
      </a>
      <h1 className="cimisy-heading">{collection.label}</h1>
      <a className="cimisy-btn cimisy-btn-primary" href={`${basePath}/${collection.name}/new`} style={{ marginBottom: 20 }}>
        + New
      </a>
      {entries === null ? (
        <p className="cimisy-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="cimisy-empty">No entries yet.</p>
      ) : (
        <ul className="cimisy-list" style={{ marginTop: 20 }}>
          {entries.map((entry) =>
            entry.error ? (
              <li key={entry.slug}>
                <div className="cimisy-card cimisy-card-error">
                  {entry.slug} — failed to parse: {entry.error}
                </div>
              </li>
            ) : (
              <li key={entry.slug}>
                <a className="cimisy-card" href={`${basePath}/${collection.name}/${entry.slug}`}>
                  {String(entry.values[collection.slugField] ?? entry.slug)}
                </a>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function EntryForm({
  collection,
  slug,
  basePath,
  apiBasePath,
}: {
  collection: CollectionManifest;
  slug: string | null;
  basePath: string;
  apiBasePath: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(slug !== null);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);

  useEffect(() => {
    if (!slug) return;
    fetch(`${apiBasePath}/collections/${collection.name}/${slug}`)
      .then((res) => res.json())
      .then((data: { entry: EntrySummaryLike }) => {
        setValues(data.entry.values);
        setVersion(data.entry.version);
        setLoading(false);
      });
  }, [collection.name, slug, apiBasePath]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${apiBasePath}/collections/${collection.name}${slug ? `/${slug}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, baseVersion: version }),
    });
    const data = (await res.json()) as { slug?: string; version?: string; publish?: PublishResult; error?: string };
    if (!res.ok || !data.slug) {
      setError(data.error ?? "Save failed");
      return;
    }
    setVersion(data.version ?? null);
    setPublishResult(data.publish ?? null);
    router.push(`${basePath}/${collection.name}/${data.slug}`);
    router.refresh();
  }

  if (loading) return <p className="cimisy-muted">Loading…</p>;

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <a className="cimisy-crumb cimisy-link" href={`${basePath}/${collection.name}`}>
          &larr; {collection.label}
        </a>
        <h1 className="cimisy-heading">{slug ?? "New entry"}</h1>
        {slug && collection.previewPath && (
          <p>
            <a className="cimisy-link" href={buildPreviewUrl(apiBasePath, collection.name, slug, collection.previewPath)}>
              Preview &rarr;
            </a>
          </p>
        )}
        {error && <p className="cimisy-banner cimisy-banner-danger">{error}</p>}
        {publishResult?.status === "direct" && <p className="cimisy-banner cimisy-banner-success">Published directly.</p>}
        {publishResult?.status === "draft" && (
          <p className="cimisy-banner cimisy-banner-warning">
            Saved as a draft on branch <code>{publishResult.branch}</code> —{" "}
            <a href={publishResult.pullRequestUrl} target="_blank" rel="noreferrer">
              view pull request &rarr;
            </a>
          </p>
        )}
        {collection.fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
          />
        ))}
        <button type="submit" className="cimisy-btn cimisy-btn-primary">
          Save
        </button>
      </form>
      {slug && <HistoryPanel collection={collection} slug={slug} apiBasePath={apiBasePath} />}
    </div>
  );
}

interface HistoryEntryLike {
  version: string;
  message: string;
  author: { name: string; email: string };
  date: string;
}

/** The activity-log UI: surfaces git history for an entry (see next/route-handler.ts's /history route). Hides itself when the storage adapter doesn't support history (e.g. the local adapter) rather than showing an empty/broken section. */
function HistoryPanel({ collection, slug, apiBasePath }: { collection: CollectionManifest; slug: string; apiBasePath: string }) {
  const [state, setState] = useState<{ supported: boolean; history: HistoryEntryLike[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBasePath}/collections/${collection.name}/${slug}/history`)
      .then((res) => res.json())
      .then((data: { supported: boolean; history: HistoryEntryLike[] }) => {
        if (!cancelled) setState(data);
      })
      .catch(() => {
        if (!cancelled) setState({ supported: false, history: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [collection.name, slug, apiBasePath]);

  if (!state?.supported) return null;

  return (
    <div className="cimisy-panel">
      <h2 className="cimisy-subheading">History</h2>
      {state.history.length === 0 ? (
        <p className="cimisy-muted">No history yet.</p>
      ) : (
        <div>
          {state.history.map((entry) => (
            <div key={entry.version} className="cimisy-history-item">
              <code>{entry.version.slice(0, 7)}</code> {entry.message} — {entry.author.name},{" "}
              {new Date(entry.date).toLocaleString()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === "blocks") {
    return <BlockEditor field={field} value={value} onChange={onChange} />;
  }
  if (field.kind === "date") {
    const dateValue = typeof value === "string" ? value.slice(0, 10) : "";
    return (
      <div className="cimisy-field">
        <label className="cimisy-label" htmlFor={field.name}>
          {field.label}
        </label>
        <input
          id={field.name}
          className="cimisy-input"
          type="date"
          value={dateValue}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")}
        />
      </div>
    );
  }
  return (
    <div className="cimisy-field">
      <label className="cimisy-label" htmlFor={field.name}>
        {field.label}
      </label>
      <input
        id={field.name}
        className="cimisy-input"
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function defaultPropsFor(typeDef: BlockTypeManifest): Record<string, unknown> {
  const uiOptions = typeDef.uiOptions ?? {};
  switch (typeDef.kind) {
    case "heading": {
      const levels = (uiOptions.levels as number[] | undefined) ?? [2];
      return { level: levels[0] ?? 2, text: "" };
    }
    case "code": {
      const languages = uiOptions.languages as string[] | undefined;
      return { code: "", language: languages?.[0] };
    }
    case "image":
      return { src: "", alt: "" };
    case "callout": {
      const tones = (uiOptions.tones as string[] | undefined) ?? ["info"];
      return { tone: tones[0] ?? "info", text: "" };
    }
    default:
      return { text: "" };
  }
}

/**
 * A generic list-of-typed-blocks editor: every block's shape/constraints
 * come entirely from the manifest (block kind + uiOptions sent by the
 * server, see next/manifest.ts) — this component has no per-project
 * knowledge baked in, so a config that registers different block types
 * just works without any client-side changes.
 */
function BlockEditor({
  field,
  value,
  onChange,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: BlockNodeLike[]) => void;
}) {
  const blocks = Array.isArray(value) ? (value as BlockNodeLike[]) : [];
  const blockTypes = field.blockTypes ?? [];

  function updateBlockProps(index: number, props: Record<string, unknown>) {
    const next = blocks.slice();
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, props };
    onChange(next);
  }
  function removeBlock(index: number) {
    onChange(blocks.filter((_, i) => i !== index));
  }
  function moveBlock(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const next = blocks.slice();
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange(next);
  }
  function addBlock(typeName: string) {
    const typeDef = blockTypes.find((t) => t.name === typeName);
    if (!typeDef) return;
    onChange([...blocks, { type: typeName, id: crypto.randomUUID(), props: defaultPropsFor(typeDef) }]);
  }

  return (
    <div className="cimisy-field">
      <label className="cimisy-label">{field.label}</label>
      <div className="cimisy-block-list">
        {blocks.length === 0 && <p className="cimisy-muted" style={{ margin: 0 }}>No blocks yet.</p>}
        {blocks.map((block, index) => {
          const typeDef = blockTypes.find((t) => t.name === block.type);
          return (
            <div key={block.id} className="cimisy-block">
              <div className="cimisy-block-header">
                <span>{typeDef?.label ?? block.type}</span>
                <span className="cimisy-block-controls">
                  <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => moveBlock(index, -1)} disabled={index === 0}>
                    &uarr;
                  </button>
                  <button
                    type="button"
                    className="cimisy-btn cimisy-btn-ghost"
                    onClick={() => moveBlock(index, 1)}
                    disabled={index === blocks.length - 1}
                  >
                    &darr;
                  </button>
                  <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => removeBlock(index)}>
                    Remove
                  </button>
                </span>
              </div>
              {typeDef ? (
                <BlockPropsEditor typeDef={typeDef} props={block.props} onChange={(props) => updateBlockProps(index, props)} />
              ) : (
                <p className="cimisy-banner cimisy-banner-danger" style={{ margin: 0 }}>
                  Unknown block type &quot;{block.type}&quot;
                </p>
              )}
            </div>
          );
        })}
      </div>
      <select
        className="cimisy-select"
        style={{ marginTop: 10 }}
        value=""
        onChange={(e) => {
          if (e.target.value) addBlock(e.target.value);
        }}
      >
        <option value="" disabled>
          + Add block…
        </option>
        {blockTypes.map((t) => (
          <option key={t.name} value={t.name}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function BlockPropsEditor({
  typeDef,
  props,
  onChange,
}: {
  typeDef: BlockTypeManifest;
  props: Record<string, unknown>;
  onChange: (props: Record<string, unknown>) => void;
}) {
  const uiOptions = typeDef.uiOptions ?? {};
  const set = (key: string, val: unknown) => onChange({ ...props, [key]: val });

  if (typeDef.kind === "heading") {
    const levels = (uiOptions.levels as number[] | undefined) ?? [1, 2, 3, 4, 5, 6];
    return (
      <div>
        <select className="cimisy-select" style={{ width: "auto", marginBottom: 6 }} value={String(props.level ?? levels[0])} onChange={(e) => set("level", Number(e.target.value))}>
          {levels.map((l) => (
            <option key={l} value={l}>
              H{l}
            </option>
          ))}
        </select>
        <input
          className="cimisy-input"
          type="text"
          value={typeof props.text === "string" ? props.text : ""}
          onChange={(e) => set("text", e.target.value)}
        />
      </div>
    );
  }
  if (typeDef.kind === "code") {
    const languages = uiOptions.languages as string[] | undefined;
    return (
      <div>
        {languages ? (
          <select
            className="cimisy-select"
            style={{ width: "auto", marginBottom: 6 }}
            value={String(props.language ?? languages[0])}
            onChange={(e) => set("language", e.target.value)}
          >
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="cimisy-input"
            type="text"
            placeholder="language"
            value={typeof props.language === "string" ? props.language : ""}
            onChange={(e) => set("language", e.target.value)}
            style={{ marginBottom: 6 }}
          />
        )}
        <textarea
          className="cimisy-textarea cimisy-textarea-mono"
          rows={6}
          value={typeof props.code === "string" ? props.code : ""}
          onChange={(e) => set("code", e.target.value)}
        />
      </div>
    );
  }
  if (typeDef.kind === "image") {
    return (
      <div>
        <input
          className="cimisy-input"
          type="text"
          placeholder="Image src"
          value={typeof props.src === "string" ? props.src : ""}
          onChange={(e) => set("src", e.target.value)}
          style={{ marginBottom: 6 }}
        />
        <input
          className="cimisy-input"
          type="text"
          placeholder="Alt text"
          value={typeof props.alt === "string" ? props.alt : ""}
          onChange={(e) => set("alt", e.target.value)}
        />
      </div>
    );
  }
  if (typeDef.kind === "callout") {
    const tones = (uiOptions.tones as string[] | undefined) ?? ["info"];
    return (
      <div>
        <select className="cimisy-select" style={{ width: "auto", marginBottom: 6 }} value={String(props.tone ?? tones[0])} onChange={(e) => set("tone", e.target.value)}>
          {tones.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <textarea
          className="cimisy-textarea"
          rows={3}
          value={typeof props.text === "string" ? props.text : ""}
          onChange={(e) => set("text", e.target.value)}
        />
      </div>
    );
  }
  // paragraph (default fallback for any other plain-text block kind)
  return (
    <textarea
      className="cimisy-textarea"
      rows={4}
      value={typeof props.text === "string" ? props.text : ""}
      onChange={(e) => set("text", e.target.value)}
    />
  );
}
