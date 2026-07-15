import type { FieldManifest } from "../../next/manifest.js";

/**
 * The `fields.array()` editor. Every array field in practice wraps
 * `fields.text()` items (see config/fields/array.ts + scan/apply.ts's
 * inferred-field heuristic and codegen/insert-collection-config.ts, which
 * only ever emit `fields.array(fields.text(...))`), so this renders a
 * plain reorderable list of text inputs rather than trying to generalize
 * to arbitrary item field kinds.
 */
export function ArrayField({
  field,
  value,
  onChange,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: string[]) => void;
}) {
  const items = Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];

  function updateItem(index: number, next: string) {
    const copy = items.slice();
    copy[index] = next;
    onChange(copy);
  }
  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }
  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const copy = items.slice();
    const a = copy[index]!;
    const b = copy[target]!;
    copy[index] = b;
    copy[target] = a;
    onChange(copy);
  }

  return (
    <div className="cimisy-field">
      <label className="cimisy-label">{field.label}</label>
      {items.length === 0 && (
        <p className="cimisy-muted" style={{ margin: "0 0 8px" }}>
          No items yet.
        </p>
      )}
      {items.map((item, index) => (
        <div key={index} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            className="cimisy-input"
            type="text"
            value={item}
            onChange={(e) => updateItem(index, e.target.value)}
          />
          <button
            type="button"
            className="cimisy-btn cimisy-btn-ghost"
            onClick={() => moveItem(index, -1)}
            disabled={index === 0}
            aria-label="Move up"
          >
            &uarr;
          </button>
          <button
            type="button"
            className="cimisy-btn cimisy-btn-ghost"
            onClick={() => moveItem(index, 1)}
            disabled={index === items.length - 1}
            aria-label="Move down"
          >
            &darr;
          </button>
          <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => removeItem(index)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="cimisy-btn cimisy-btn-secondary" onClick={() => onChange([...items, ""])}>
        + Add
      </button>
    </div>
  );
}
