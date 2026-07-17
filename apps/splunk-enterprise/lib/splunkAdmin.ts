// =============================================================================
// splunkAdmin — relay a customer-chosen admin password onto splunkd.
//
// Used by the activation flow: the admin sets their password via the one-time
// link, and this POSTs it to splunkd's authentication/users endpoint (over the
// same TLS/mgmt path the other handlers use) and clears force-change-pass. The
// customer's password is relayed straight through — Veltrix never stores it.
//
// Authenticates with the BOOTSTRAP admin credential (Veltrix-generated at
// bring-up, held in the env secret). Once the customer's password is set, that
// bootstrap secret no longer works — the customer becomes the sole holder.
// =============================================================================

import { postForm } from './splunkApi'

export interface RelayInput {
  /** splunkd management base URL, e.g. https://mgmt.<cust>-<env>...:8089 */
  managementUrl: string
  /** Bootstrap admin credential (from the env secret) used to authenticate. */
  bootstrapUsername: string
  bootstrapPassword: string
  /** The admin account whose password is being set (usually 'admin'). */
  adminUser: string
  /** The customer's chosen password — relayed, never persisted by Veltrix. */
  newPassword: string
}

/** Set the admin password and clear force-change-pass. Throws on a non-2xx from
 *  splunkd (e.g. bad bootstrap creds → 401). */
export async function relayAdminPassword(input: RelayInput): Promise<void> {
  const encoded = Buffer.from(`${input.bootstrapUsername}:${input.bootstrapPassword}`).toString('base64')
  const auth = { Authorization: `Basic ${encoded}` }
  const base = input.managementUrl.replace(/\/+$/, '')
  await postForm(base, auth, `/services/authentication/users/${encodeURIComponent(input.adminUser)}`, {
    password: input.newPassword,
    'force-change-pass': false,
  })
}
