// Shared helpers for the Orca Trusted Cloud Accounts config type (deploy +
// rollback + drift).
//
// Orca trusted cloud accounts follow the /api/organization/trusted_accounts
// surface (VERIFIED against terraform-provider-orcasecurity
// api_client/trusted_cloud_account.go). Two verified quirks, both honored
// exactly by this file:
//   - The id travels as a QUERY PARAMETER (?id=), never a path segment, on
//     every operation except create.
//   - GET returns an ARRAY even for a single-id lookup ({ data: [ {...} ] }),
//     while POST/PUT return a SINGLE object ({ data: {...} }) — a genuine
//     asymmetry between read and write envelopes, not a bug in this file.
//
//   POST /api/organization/trusted_accounts            create; body { account_name, description, cloud_provider, cloud_provider_id }
//                                                        -> { data: { id, ... } }
//   GET  /api/organization/trusted_accounts?id={id}     read;   -> { data: [ { id, ... } ] }
//   PUT  /api/organization/trusted_accounts?id={id}     update; body includes numeric id
//   DELETE /api/organization/trusted_accounts?id={id}   delete
//
// A trusted cloud account marks a named cloud account (e.g. a vendor's account
// with read access into yours) as trusted, so Orca does not flag its access.

import { dataFromEnvelope, type ReconcileData, type ReconcileEntry } from '../../lib/reconcile'

/** Valid Orca cloud providers for a trusted account (mirrors canvas.yaml — no "shiftleft" here, unlike business units). */
export const CLOUD_PROVIDERS = new Set<string>(['alicloud', 'aws', 'azure', 'gcp', 'oci'])

/** One Orca trusted cloud account. `id` is numeric on the wire; this app carries it as a string once assigned. */
export interface OrcaTrustedCloudAccount {
  id?: number | string
  account_name?: string
  description?: string
  cloud_provider?: string
  cloud_provider_id?: string
  [key: string]: unknown
}

export type TrustedCloudAccountRollbackEntry = ReconcileEntry<OrcaTrustedCloudAccount>
export type TrustedCloudAccountRollbackData = ReconcileData<OrcaTrustedCloudAccount>

/** Build the Orca trusted-cloud-account body from canvas fields (POST/PUT payload). */
export function buildTrustedCloudAccountBody(fields: Record<string, unknown>, serverId?: string | null): OrcaTrustedCloudAccount {
  const body: OrcaTrustedCloudAccount = {
    account_name: String(fields.accountName ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    cloud_provider: String(fields.cloudProvider ?? '').trim(),
    cloud_provider_id: String(fields.cloudAccountId ?? '').trim(),
  }
  // The official provider's PUT sends the numeric id inline on the body; this
  // app mirrors that for wire fidelity. Harmless for POST (no id yet).
  if (serverId) body.id = Number(serverId)
  return body
}

/** Unwrap the WRITE envelope: { data: {...} } (a single object, from POST/PUT). */
export function accountFromWriteEnvelope(payload: unknown): OrcaTrustedCloudAccount | null {
  return dataFromEnvelope<OrcaTrustedCloudAccount>(payload)
}

/** Unwrap the READ envelope: { data: [...] } (an ARRAY, from GET, even for one id). */
export function accountFromReadEnvelope(payload: unknown): OrcaTrustedCloudAccount | null {
  const list = dataFromEnvelope<OrcaTrustedCloudAccount[]>(payload)
  return Array.isArray(list) && list.length > 0 ? list[0] : null
}
