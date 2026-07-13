import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedSingleton } from "../../config/define-config.js";
import { fields } from "../../config/fields/index.js";
import { LocalStorageAdapter } from "../../storage/local.js";
import { readSingleton, writeSingleton } from "../singleton-store.js";

const AUTHOR = { id: "1", name: "Test", email: "test@example.com" };

const settingsDef: NormalizedSingleton = {
  key: "settings",
  label: "Settings",
  path: "content/settings.yaml",
  format: "yaml",
  schema: { siteName: fields.text({ label: "Site name" }) },
};

describe("singleton store", () => {
  let rootDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "cimisy-singleton-store-test-"));
    adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("reads null (not an error) when the singleton file doesn't exist yet", async () => {
    expect(await readSingleton(adapter, settingsDef)).toBeNull();
  });

  it("creates the file on first write and round-trips values + version", async () => {
    const result = await writeSingleton(adapter, settingsDef, {
      values: { siteName: "Acme" },
      baseVersion: null,
      author: AUTHOR,
      message: "create settings",
      ref: "main",
    });
    expect(result.conflict).toBeUndefined();

    const snapshot = await readSingleton(adapter, settingsDef);
    expect(snapshot?.values).toEqual({ siteName: "Acme" });
    expect(snapshot?.version).toBe(result.version);
  });

  it("reports a conflict on a stale baseVersion instead of overwriting", async () => {
    const first = await writeSingleton(adapter, settingsDef, {
      values: { siteName: "Acme" },
      baseVersion: null,
      author: AUTHOR,
      message: "create",
      ref: "main",
    });
    await writeSingleton(adapter, settingsDef, {
      values: { siteName: "Acme v2" },
      baseVersion: first.version ?? null,
      author: AUTHOR,
      message: "update",
      ref: "main",
    });

    const stale = await writeSingleton(adapter, settingsDef, {
      values: { siteName: "Acme stale" },
      baseVersion: first.version ?? null,
      author: AUTHOR,
      message: "stale update",
      ref: "main",
    });
    expect(stale.conflict).toBeTruthy();
    expect((await readSingleton(adapter, settingsDef))?.values).toEqual({ siteName: "Acme v2" });
  });
});
