// Cribl Global Variables config type — reusable named values/expressions over
// /api/v1/m/<group>/lib/vars. Shares the generic record CRUD engine in
// lib/criblRecordEntities. A GlobalVar is a flat named record:
//   { id, lib, description, type, value, tags, args? }
// `args` (argument definitions) only applies to `type: expression` and is
// authored as JSON, since it's a small array of { type, name } pairs.
//
// ⚠ `type: encryptedString` stores `value` encrypted server-side — Cribl does
// not necessarily echo an encrypted value back verbatim on GET, so an
// encryptedString var's `value` may show as unrelated drift after a deploy,
// and its prior value (captured before an update) may not be a faithful
// rollback target. This is a documented, accepted limitation (see README) —
// every other `type` round-trips normally.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const GLOBAL_VAR: RecordDescriptor = {
  resource: 'lib/vars',
  kind: 'global variable',
  Kind: 'Global Variable',
}

export const GLOBAL_VAR_TYPES = ['string', 'number', 'encryptedString', 'boolean', 'array', 'object', 'expression', 'any'] as const

export function buildGlobalVarRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const type = String(fields.type ?? 'any').trim() || 'any'
  if (!(GLOBAL_VAR_TYPES as readonly string[]).includes(type)) {
    return { id, body: null, error: `type "${type}" must be one of: ${GLOBAL_VAR_TYPES.join(', ')}.` }
  }

  const body: Record<string, unknown> = { id, type, lib: String(fields.lib ?? 'custom').trim() || 'custom' }
  const value = String(fields.value ?? '')
  if (value) body.value = value
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags

  const argsText = String(fields.args ?? '').trim()
  if (argsText) {
    let parsed: unknown
    try {
      parsed = JSON.parse(argsText)
    } catch (e) {
      return { id, body: null, error: `args is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
    if (!Array.isArray(parsed)) return { id, body: null, error: 'args must be a JSON array of { "type", "name" } objects.' }
    body.args = parsed
  }

  return { id, body, error: null }
}
