// Cribl Event Breaker Rulesets config type — rules that split a raw byte
// stream into events, over /api/v1/m/<group>/lib/breakers. Shares the generic
// record CRUD engine in lib/criblRecordEntities. An EventBreakerRuleset is:
//   { id, lib, description, tags, minRawLength, rules: [ ... ] }
// where `rules` (order-significant, applied top to bottom) is arbitrary-enough
// per breaker type (regex/json/csv/header/timestamp/aws_cloudtrail/...) that it
// is authored as JSON, matching how this app already treats Pipelines'
// Function chain and Routes' ordered table. Its schema declares
// `additionalProperties: false`, so the body below MUST only ever include
// these exact keys.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const EVENT_BREAKER: RecordDescriptor = {
  resource: 'lib/breakers',
  kind: 'Event Breaker ruleset',
  Kind: 'Event Breaker Ruleset',
}

export interface ParsedRules {
  rules: unknown[] | null
  error: string | null
}

/** Parse the `rules` textarea (JSON array of breaker rules). */
export function parseRules(raw: unknown): ParsedRules {
  const text = String(raw ?? '').trim()
  if (!text) return { rules: null, error: 'rules is empty — provide at least one Event Breaker rule as JSON.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { rules: null, error: `rules is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { rules: null, error: 'rules must be a JSON array of rule objects.' }
  return { rules: parsed, error: null }
}

export function buildEventBreakerRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }

  const { rules, error } = parseRules(fields.rules)
  if (error || !rules) return { id, body: null, error: error ?? 'invalid rules' }

  const body: Record<string, unknown> = { id, lib: String(fields.lib ?? 'custom').trim() || 'custom', rules }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags
  const minRawLength = fields.min_raw_length
  if (minRawLength !== undefined && minRawLength !== null && minRawLength !== '') {
    const n = Number(minRawLength)
    if (!Number.isNaN(n)) body.minRawLength = n
  }

  return { id, body, error: null }
}
