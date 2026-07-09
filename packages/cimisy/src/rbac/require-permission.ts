import type { Action, RoleDefinition } from "../config/define-config.js";
import { ForbiddenError } from "../shared/errors.js";
import { matchPathGlob } from "./glob.js";

/**
 * The single, centralized authorization choke point. Every request that
 * touches content — read or write — must pass through here before it
 * touches the StorageAdapter. Deny-by-default: if no rule explicitly
 * permits the action, it's forbidden, full stop. This is what stands
 * between the admin API and IDOR-class bugs — a route handler that forgets
 * to call this is a bug to fix here, not a place to special-case.
 */
export function requirePermission(role: RoleDefinition, action: Action, path: string): void {
  const permitted = role.rules.some(
    (rule) => rule.actions.includes(action) && matchPathGlob(rule.path, path),
  );
  if (!permitted) {
    throw new ForbiddenError(`Not permitted: "${action}" on "${path}".`);
  }
}
