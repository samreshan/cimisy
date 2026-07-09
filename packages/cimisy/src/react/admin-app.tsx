"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { AdminManifest, BlockTypeManifest, CollectionManifest, FieldManifest } from "../next/manifest.js";

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
  role?: string;
}

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

  if (me === null) return <p>Loading…</p>;
  if (!me.authenticated) return <SignInGate apiBasePath={apiBasePath} />;

  return (
    <div>
      <AuthBar user={me.user} role={me.role} apiBasePath={apiBasePath} />
      <AdminRoutes manifest={manifest} segments={segments} basePath={basePath} apiBasePath={apiBasePath} />
    </div>
  );
}

function SignInGate({ apiBasePath }: { apiBasePath: string }) {
  return (
    <div>
      <h1>cimisy admin</h1>
      <p>
        <a href={`${apiBasePath}/auth/login`}>Sign in with GitHub &rarr;</a>
      </p>
    </div>
  );
}

function AuthBar({ user, role, apiBasePath }: { user: MeResponse["user"]; role?: string; apiBasePath: string }) {
  async function handleLogout() {
    await fetch(`${apiBasePath}/auth/logout`, { method: "POST" });
    window.location.reload();
  }
  if (!user) return null;
  return (
    <p style={{ fontSize: "0.85em", color: "#666" }}>
      Signed in as {user.name}
      {role && ` (${role})`} &middot;{" "}
      <button type="button" onClick={handleLogout} style={{ font: "inherit", padding: 0 }}>
        Sign out
      </button>
    </p>
  );
}

function AdminRoutes({ manifest, segments, basePath, apiBasePath }: AdminAppProps) {
  const [collectionName, slug] = segments;

  if (!collectionName) {
    return <CollectionList manifest={manifest} basePath={basePath} />;
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
      <h1>cimisy admin</h1>
      <ul>
        {manifest.collections.map((c) => (
          <li key={c.name}>
            <a href={`${basePath}/${c.name}`}>{c.label}</a>
          </li>
        ))}
      </ul>
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
      <p>
        <a href={basePath}>&larr; Collections</a>
      </p>
      <h1>{collection.label}</h1>
      <p>
        <a href={`${basePath}/${collection.name}/new`}>+ New</a>
      </p>
      {entries === null ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No entries yet.</p>
      ) : (
        <ul>
          {entries.map((entry) =>
            entry.error ? (
              <li key={entry.slug} style={{ color: "crimson" }}>
                {entry.slug} — failed to parse: {entry.error}
              </li>
            ) : (
              <li key={entry.slug}>
                <a href={`${basePath}/${collection.name}/${entry.slug}`}>
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

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <p>
          <a href={`${basePath}/${collection.name}`}>&larr; {collection.label}</a>
        </p>
        <h1>{slug ?? "New entry"}</h1>
        {slug && collection.previewPath && (
          <p>
            <a href={buildPreviewUrl(apiBasePath, collection.name, slug, collection.previewPath)}>Preview &rarr;</a>
          </p>
        )}
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        {publishResult?.status === "direct" && <p style={{ color: "seagreen" }}>Published directly.</p>}
        {publishResult?.status === "draft" && (
          <p style={{ color: "darkorange" }}>
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
        <button type="submit">Save</button>
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
    <div style={{ marginTop: 24, borderTop: "1px solid #eee", paddingTop: 12 }}>
      <h2 style={{ fontSize: "1em" }}>History</h2>
      {state.history.length === 0 ? (
        <p style={{ color: "#888" }}>No history yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {state.history.map((entry) => (
            <li key={entry.version} style={{ fontSize: "0.85em", color: "#666", marginBottom: 6 }}>
              <code>{entry.version.slice(0, 7)}</code> {entry.message} — {entry.author.name},{" "}
              {new Date(entry.date).toLocaleString()}
            </li>
          ))}
        </ul>
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
      <div>
        <label htmlFor={field.name}>{field.label}</label>
        <br />
        <input
          id={field.name}
          type="date"
          value={dateValue}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")}
        />
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={field.name}>{field.label}</label>
      <br />
      <input
        id={field.name}
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
    <div>
      <label>{field.label}</label>
      <div style={{ border: "1px solid #ddd", borderRadius: 4, padding: 8, marginTop: 4 }}>
        {blocks.length === 0 && <p style={{ color: "#888", margin: 0 }}>No blocks yet.</p>}
        {blocks.map((block, index) => {
          const typeDef = blockTypes.find((t) => t.name === block.type);
          return (
            <div key={block.id} style={{ border: "1px solid #eee", borderRadius: 4, padding: 8, marginBottom: 8 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.8em",
                  color: "#888",
                  marginBottom: 4,
                }}
              >
                <span>{typeDef?.label ?? block.type}</span>
                <span>
                  <button type="button" onClick={() => moveBlock(index, -1)} disabled={index === 0}>
                    &uarr;
                  </button>{" "}
                  <button type="button" onClick={() => moveBlock(index, 1)} disabled={index === blocks.length - 1}>
                    &darr;
                  </button>{" "}
                  <button type="button" onClick={() => removeBlock(index)}>
                    Remove
                  </button>
                </span>
              </div>
              {typeDef ? (
                <BlockPropsEditor typeDef={typeDef} props={block.props} onChange={(props) => updateBlockProps(index, props)} />
              ) : (
                <p style={{ color: "crimson" }}>Unknown block type &quot;{block.type}&quot;</p>
              )}
            </div>
          );
        })}
      </div>
      <select
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
        <select value={String(props.level ?? levels[0])} onChange={(e) => set("level", Number(e.target.value))}>
          {levels.map((l) => (
            <option key={l} value={l}>
              H{l}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={typeof props.text === "string" ? props.text : ""}
          onChange={(e) => set("text", e.target.value)}
          style={{ width: "100%", marginTop: 4 }}
        />
      </div>
    );
  }
  if (typeDef.kind === "code") {
    const languages = uiOptions.languages as string[] | undefined;
    return (
      <div>
        {languages ? (
          <select value={String(props.language ?? languages[0])} onChange={(e) => set("language", e.target.value)}>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            placeholder="language"
            value={typeof props.language === "string" ? props.language : ""}
            onChange={(e) => set("language", e.target.value)}
          />
        )}
        <br />
        <textarea
          rows={6}
          style={{ width: "100%", marginTop: 4, fontFamily: "monospace" }}
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
          type="text"
          placeholder="Image src"
          value={typeof props.src === "string" ? props.src : ""}
          onChange={(e) => set("src", e.target.value)}
          style={{ width: "100%" }}
        />
        <input
          type="text"
          placeholder="Alt text"
          value={typeof props.alt === "string" ? props.alt : ""}
          onChange={(e) => set("alt", e.target.value)}
          style={{ width: "100%", marginTop: 4 }}
        />
      </div>
    );
  }
  if (typeDef.kind === "callout") {
    const tones = (uiOptions.tones as string[] | undefined) ?? ["info"];
    return (
      <div>
        <select value={String(props.tone ?? tones[0])} onChange={(e) => set("tone", e.target.value)}>
          {tones.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <textarea
          rows={3}
          style={{ width: "100%", marginTop: 4 }}
          value={typeof props.text === "string" ? props.text : ""}
          onChange={(e) => set("text", e.target.value)}
        />
      </div>
    );
  }
  // paragraph (default fallback for any other plain-text block kind)
  return (
    <textarea
      rows={4}
      style={{ width: "100%" }}
      value={typeof props.text === "string" ? props.text : ""}
      onChange={(e) => set("text", e.target.value)}
    />
  );
}
