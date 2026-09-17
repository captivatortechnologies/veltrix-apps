// Shared fixtures for the mfa-configs handler tests.
//
// An MFA method config is a per-method singleton: there is no collection to list
// and no id, so the method name IS the address. `configProperties` carry the
// provider secret, which ISC masks on read — so they are applied but never read
// back, and nothing in the rollback entry pretends otherwise.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const METHOD = 'okta-verify'
export const CONFIG_PATH = `/v3/mfa/${METHOD}/config`
export const DELETE_PATH = `/v3/mfa/${METHOD}/config/delete`

export function mfaItem(fields: Record<string, unknown> = {}) {
  return item('Okta Verify', {
    method: METHOD,
    enabled: true,
    identityAttribute: 'email',
    configProperties: { clientId: 'okta-verify-client' },
    ...fields,
  })
}

/** The method as the tenant has it now: off, and reading a different attribute. */
export function liveConfig(over: Record<string, unknown> = {}) {
  return { mfaMethod: METHOD, enabled: false, identityAttribute: 'legacyMail', ...over }
}

/** A live config matching {@link mfaItem} in every field drift tracks. */
export function inSyncConfig(over: Record<string, unknown> = {}) {
  return { mfaMethod: METHOD, enabled: true, identityAttribute: 'email', ...over }
}
