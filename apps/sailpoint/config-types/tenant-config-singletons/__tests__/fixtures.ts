// Shared fixtures for the tenant-config-singletons handler tests.
//
// These are tenant-wide singletons with no collection and no create/delete: each
// is read, merged (PUT) or patched (PATCH), and reverted from the snapshot taken
// before the write. Both write styles are covered, because they record different
// priors — a PUT snapshots the WHOLE object, a PATCH only the keys the canvas
// declared.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const PUT_SETTING = 'password-org-config'
export const PUT_PATH = '/v3/password-org-config'
export const PATCH_SETTING = 'auth-org-lockout'
export const PATCH_PATH = '/v3/auth-org/lockout-config'

/** A singleton ISC replaces wholesale. */
export function putItem(fields: Record<string, unknown> = {}) {
  return item('Password Org Config', {
    setting: PUT_SETTING,
    config: { customInstructionsEnabled: true },
    ...fields,
  })
}

/** A singleton ISC edits with JSON-Patch. */
export function patchItem(fields: Record<string, unknown> = {}) {
  return item('Lockout Config', {
    setting: PATCH_SETTING,
    config: { maximumAttempts: 5, lockoutDuration: 15 },
    ...fields,
  })
}

/** What the tenant currently has for the PUT singleton — note the unmanaged keys. */
export function livePutConfig(over: Record<string, unknown> = {}) {
  return { customInstructionsEnabled: false, digitTokenEnabled: true, digitTokenLength: 6, ...over }
}

/** What the tenant currently has for the PATCH singleton. */
export function livePatchConfig(over: Record<string, unknown> = {}) {
  return { maximumAttempts: 10, lockoutDuration: 30, lockoutWindow: 60, ...over }
}
