import type { FieldManifest } from "../../next/manifest.js";

type ItemValue = string | number | null;

/**
 * The `fields.array()` editor. The item input renders by the wrapped item
 * field's kind (see FieldManifest.item — text, multiline text, number,
 * select); anything more exotic (image/blocks/seo items) isn't a shape
 * `fields.array()` produces today and falls back to a text input rather
 * than an error.
 */
export function ArrayField({
  field,
  value,
  onChange,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: ItemValue[]) => void;
}) {
  const item = field.item;
  const itemKind = item?.kind ?? "text";
  const items: ItemValue[] = Array.isArray(value)
    ? value.map((v) => (typeof v === "string" || typeof v === "number" ? v : itemKind === "number" ? null : ""))
    : [];

  function emptyItem(): ItemValue {
    return itemKind === "number" ? null : "";
  }
  function updateItem(index: number, next: ItemValue) {
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

  function renderItemInput(itemValue: ItemValue, index: number) {
    if (itemKind === "number") {
      return (
        <input
          className="cimisy-input"
          type="number"
          value={typeof itemValue === "number" ? itemValue : ""}
          min={item?.min}
          max={item?.max}
          onChange={(e) => updateItem(index, e.target.value === "" ? null : Number(e.target.value))}
          aria-label={`${field.label} item ${index + 1}`}
        />
      );
    }
    if (itemKind === "select") {
      return (
        <select
          className="cimisy-select"
          value={typeof itemValue === "string" ? itemValue : ""}
          onChange={(e) => updateItem(index, e.target.value)}
          aria-label={`${field.label} item ${index + 1}`}
        >
          <option value="">—</option>
          {(item?.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    if (itemKind === "text" && item?.multiline) {
      return (
        <textarea
          className="cimisy-textarea"
          rows={3}
          value={typeof itemValue === "string" ? itemValue : ""}
          onChange={(e) => updateItem(index, e.target.value)}
          aria-label={`${field.label} item ${index + 1}`}
        />
      );
    }
    return (
      <input
        className="cimisy-input"
        type="text"
        value={typeof itemValue === "string" ? itemValue : ""}
        maxLength={item?.maxLength}
        onChange={(e) => updateItem(index, e.target.value)}
        aria-label={`${field.label} item ${index + 1}`}
      />
    );
  }

  return (
    <div className="cimisy-field">
      <label className="cimisy-label">{field.label}</label>
      {items.length === 0 && (
        <p className="cimisy-muted" style={{ margin: "0 0 8px" }}>
          No items yet.
        </p>
      )}
      {items.map((itemValue, index) => (
        <div key={index} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
          {renderItemInput(itemValue, index)}
          <button
            type="button"
            className="cimisy-btn cimisy-btn-ghost"
            onClick={() => moveItem(index, -1)}
            disabled={index === 0}
            aria-label={`Move ${field.label} item ${index + 1} up`}
          >
            &uarr;
          </button>
          <button
            type="button"
            className="cimisy-btn cimisy-btn-ghost"
            onClick={() => moveItem(index, 1)}
            disabled={index === items.length - 1}
            aria-label={`Move ${field.label} item ${index + 1} down`}
          >
            &darr;
          </button>
          <button
            type="button"
            className="cimisy-btn cimisy-btn-ghost"
            onClick={() => removeItem(index)}
            aria-label={`Remove ${field.label} item ${index + 1}`}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="cimisy-btn cimisy-btn-secondary" onClick={() => onChange([...items, emptyItem()])}>
        + Add
      </button>
    </div>
  );
}
