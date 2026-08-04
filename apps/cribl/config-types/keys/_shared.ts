// Cribl Keys config type — encryption key METADATA over
// /api/v1/m/<group>/system/keys. Shares the generic record CRUD engine in
// lib/criblRecordEntities. A KeyMetadataEntity's identity field is `keyId`
// (not `id` like every other Cribl resource this app manages) — see
// RecordDescriptor.identityKey.
//
// INTENTIONALLY OMITTED: `plainKey` / `cipherKey` — the schema allows a caller
// to supply literal key bytes, but this app deliberately never does, so
// Cribl's local KMS always generates the material server-side. This mirrors
// the official `criblio/terraform-provider-criblio`'s own field omission for
// this resource (see README "Intentionally excluded") and keeps Key
// management fully metadata-only — nothing secret ever passes through this
// config type.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const KEY: RecordDescriptor = {
  resource: 'system/keys',
  kind: 'encryption key',
  Kind: 'Encryption Key',
  identityKey: 'keyId',
}

export const KEY_ALGORITHMS = ['aes-256-cbc', 'aes-256-gcm'] as const
export const KEY_IV_SIZES = [12, 13, 14, 15, 16] as const

export function buildKeyRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const algorithm = String(fields.algorithm ?? 'aes-256-cbc').trim() || 'aes-256-cbc'
  if (!(KEY_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return { id, body: null, error: `algorithm "${algorithm}" must be one of: ${KEY_ALGORITHMS.join(', ')}.` }
  }

  const body: Record<string, unknown> = {
    keyId: id,
    algorithm,
    kms: String(fields.kms ?? 'local').trim() || 'local',
    keyclass: Number(fields.keyclass ?? 0) || 0,
  }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  if (fields.use_iv !== undefined) body.useIV = Boolean(fields.use_iv)
  const ivSize = fields.iv_size
  if (ivSize !== undefined && ivSize !== null && ivSize !== '') body.ivSize = Number(ivSize)
  const expires = fields.expires
  if (expires !== undefined && expires !== null && expires !== '') body.expires = Number(expires)

  return { id, body, error: null }
}
