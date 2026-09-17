// Shared fixtures for the verified-from-addresses handler tests.
//
// A verified from-address is registered and then verified out of band by clicking
// a link in an email, so there is nothing to update: an address is either already
// registered or it is created. Everything is keyed by the address itself.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const EMAIL = 'no-reply@acme.example'
export const LIVE_ID = 'vfa-9911cd'
export const BASE = '/beta/verified-from-addresses'

export function addressItem(fields: Record<string, unknown> = {}) {
  return item(EMAIL, { email: EMAIL, ...fields })
}

/** A registered, verified address. */
export function liveAddress(over: Record<string, unknown> = {}) {
  return { id: LIVE_ID, email: EMAIL, verified: true, ...over }
}
