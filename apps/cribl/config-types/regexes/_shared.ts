// Cribl Regex Library config type — reusable regex patterns over
// /api/v1/m/<group>/lib/regex. Shares the generic record CRUD engine in
// lib/criblRecordEntities. A Regex Library entry is a flat named record:
// { id, lib, description, regex, sampleData, tags }. NOTE: `additionalProperties`
// is not restricted on this schema, but the body below only ever includes these
// documented fields. Verify against a live Cribl.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const REGEX: RecordDescriptor = {
  resource: 'lib/regex',
  kind: 'regex library entry',
  Kind: 'Regex Library Entry',
}

export function buildRegexRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const regex = String(fields.regex ?? '').trim()
  if (!regex) return { id, body: null, error: 'regex is empty — provide the regular expression pattern.' }

  const body: Record<string, unknown> = { id, regex, lib: String(fields.lib ?? 'custom').trim() || 'custom' }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const sampleData = String(fields.sample_data ?? '').trim()
  if (sampleData) body.sampleData = sampleData
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags

  return { id, body, error: null }
}
