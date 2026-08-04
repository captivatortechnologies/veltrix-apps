// Cribl Parsers config type — reusable format-parser library entries over
// /api/v1/m/<group>/lib/parsers. Shares the generic record CRUD engine in
// lib/criblRecordEntities. A ParserLibEntry is a flat named record:
// { id, type, lib, description, tags }. Its schema declares
// `additionalProperties: false`, so the body below MUST only ever include
// these exact keys.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const PARSER: RecordDescriptor = {
  resource: 'lib/parsers',
  kind: 'parser',
  Kind: 'Parser',
}

/** The parser/formatter types Cribl's ParserLibEntry accepts. */
export const PARSER_TYPES = ['csv', 'elff', 'clf', 'kvp', 'json', 'delim', 'regex', 'grok'] as const

export function buildParserRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const type = String(fields.type ?? '').trim()
  if (!type) return { id, body: null, error: 'type is required (the parser/formatter type, e.g. csv, json, kvp).' }
  if (!(PARSER_TYPES as readonly string[]).includes(type)) {
    return { id, body: null, error: `type "${type}" must be one of: ${PARSER_TYPES.join(', ')}.` }
  }

  const body: Record<string, unknown> = { id, type, lib: String(fields.lib ?? 'custom').trim() || 'custom' }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags

  return { id, body, error: null }
}
