import { describe, expect, it } from "vitest";
import type { RoleDefinition } from "../../config/define-config.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requirePermission } from "../require-permission.js";

const editor: RoleDefinition = {
  directPublish: false,
  rules: [
    { path: "content/blog/**", actions: ["read", "write"] },
    { path: "content/settings/**", actions: ["read"] },
  ],
};

const viewer: RoleDefinition = { directPublish: false, rules: [{ path: "**", actions: ["read"] }] };
const noRules: RoleDefinition = { directPublish: false, rules: [] };

describe("requirePermission", () => {
  it("allows an action a rule explicitly permits", () => {
    expect(() => requirePermission(editor, "write", "content/blog/post.mdx")).not.toThrow();
    expect(() => requirePermission(editor, "read", "content/blog/post.mdx")).not.toThrow();
  });

  it("denies an action within a path the role can only read", () => {
    expect(() => requirePermission(editor, "write", "content/settings/site.yaml")).toThrow(ForbiddenError);
    expect(() => requirePermission(editor, "read", "content/settings/site.yaml")).not.toThrow();
  });

  it("denies any action outside every rule's path (deny-by-default)", () => {
    expect(() => requirePermission(editor, "read", "content/other/thing.mdx")).toThrow(ForbiddenError);
    expect(() => requirePermission(editor, "write", "content/other/thing.mdx")).toThrow(ForbiddenError);
  });

  it("denies publish/manageSchema for a role whose rules never grant them", () => {
    expect(() => requirePermission(editor, "publish", "content/blog/post.mdx")).toThrow(ForbiddenError);
    expect(() => requirePermission(editor, "manageSchema", "content/blog/post.mdx")).toThrow(ForbiddenError);
  });

  it("a read-only role can never write, even under its own allowed path", () => {
    expect(() => requirePermission(viewer, "read", "anything/at/all.mdx")).not.toThrow();
    expect(() => requirePermission(viewer, "write", "anything/at/all.mdx")).toThrow(ForbiddenError);
  });

  it("a role with no rules at all denies everything", () => {
    expect(() => requirePermission(noRules, "read", "content/blog/post.mdx")).toThrow(ForbiddenError);
  });

  it("never grants access based on a client-supplied flag — only the role's own rules matter", () => {
    // Simulates a forged/hidden-UI-bypassing request: nothing about the call
    // site can override rule evaluation, there's no escape hatch parameter.
    expect(() => requirePermission(viewer, "write", "content/blog/post.mdx")).toThrow(ForbiddenError);
  });
});
