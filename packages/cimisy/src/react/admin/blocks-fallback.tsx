import type { BlockTypeManifest, FieldManifest } from "../../next/manifest.js";

export interface BlockNodeLike {
  type: string;
  id: string;
  props: Record<string, unknown>;
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
 *
 * This is the pre-Tiptap fallback editor (M6 adds a rich block-list
 * editor for built-in block kinds); it stays as the editing surface for
 * any block kind the rich editor doesn't recognize (custom
 * project-registered blocks), so it's never fully retired.
 */
export function BlockEditor({
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

export function BlockPropsEditor({
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
