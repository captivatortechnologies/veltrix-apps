// Cribl Secrets config type — the local Secrets store (referenced elsewhere as
// `${{secret:<id>}}`) over /api/v1/m/<group>/system/secrets. Shares the
// generic record CRUD engine in lib/criblRecordEntities. A Secret is a flat
// named record: { id, secretType, description, tags, + type-specific fields }
//   secretType "text"        → value
//   secretType "credentials" → username, password
//   secretType "keypair"     → apiKey, secretKey
//
// ⚠ WRITE-ONLY SECRETS: `value`, `password`, `apiKey` and `secretKey` are
// never echoed back by Cribl, so each is sent ONLY when its canvas field is
// non-blank, is never captured into rollbackData, and is never drift-checked
// (see lib/criblRecordEntities' `sensitiveKeys`). Same trade-off as
// apps/cisco-ise's internal-users write-only password.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const SECRET: RecordDescriptor = {
  resource: 'system/secrets',
  kind: 'secret',
  Kind: 'Secret',
  sensitiveKeys: ['value', 'password', 'apiKey', 'secretKey'],
}

export const SECRET_TYPES = ['text', 'keypair', 'credentials'] as const

export function buildSecretRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const secretType = String(fields.secret_type ?? '').trim()
  if (!secretType) return { id, body: null, error: 'secret_type is required (text, keypair or credentials).' }
  if (!(SECRET_TYPES as readonly string[]).includes(secretType)) {
    return { id, body: null, error: `secret_type "${secretType}" must be one of: ${SECRET_TYPES.join(', ')}.` }
  }

  const body: Record<string, unknown> = { id, secretType }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags

  if (secretType === 'text') {
    const value = String(fields.value ?? '')
    if (value) body.value = value
  } else if (secretType === 'credentials') {
    const username = String(fields.username ?? '').trim()
    if (username) body.username = username
    const password = String(fields.password ?? '')
    if (password) body.password = password
  } else if (secretType === 'keypair') {
    const apiKey = String(fields.api_key ?? '')
    if (apiKey) body.apiKey = apiKey
    const secretKey = String(fields.secret_key ?? '')
    if (secretKey) body.secretKey = secretKey
  }

  return { id, body, error: null }
}
