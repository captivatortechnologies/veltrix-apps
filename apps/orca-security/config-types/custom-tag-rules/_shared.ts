// Shared helpers for the Orca Custom Tag Rules config type (deploy + rollback +
// drift).
//
// Orca custom tag rules follow the /api/custom_tags surface (VERIFIED against
// terraform-provider-orcasecurity api_client/custom_tag_rule.go):
//   POST   /api/custom_tags        create; returns { data: { tags_rule_id } } — NOTE the
//                                  create response has NO echoed body, only the new id
//                                  (the official provider issues a follow-up GET; this
//                                  app does not need the full body immediately, so it
//                                  skips that extra round-trip and lets the NEXT deploy's
//                                  update path fetch it when needed)
//   GET    /api/custom_tags/{id}    read;   returns { data: { id, name, description, tags, rule, rule_type, disabled } }
//   PUT    /api/custom_tags/{id}    update
//   DELETE /api/custom_tags/{id}    delete
//
// A rule automatically applies its `tags` (a key/value map) to every asset
// matching `rule` — a Sonar (DSL) query STRING when rule_type is "string", or a
// discovery query OBJECT when rule_type is "json". When rule_type is "json",
// the wire body's `rule` field must be the PARSED object, not a JSON string —
// this file's buildCustomTagRuleBody handles that distinction.

import { readKeyValueMap, type ReconcileData, type ReconcileEntry } from '../../lib/reconcile'

export const RULE_TYPES = new Set<string>(['string', 'json'])

/** One Orca custom tag rule (the `data` payload of /api/custom_tags responses, read/update shape). */
export interface OrcaTagRule {
  id?: string
  name?: string
  description?: string
  tags?: Record<string, string>
  rule?: unknown
  rule_type?: string
  disabled?: boolean
  [key: string]: unknown
}

/** The create-response shape: { data: { tags_rule_id } } — no echoed body. */
export interface OrcaTagRuleCreateResponse {
  tags_rule_id?: string
}

export type TagRuleRollbackEntry = ReconcileEntry<OrcaTagRule>
export type TagRuleRollbackData = ReconcileData<OrcaTagRule>

/** Discriminated result of building a tag-rule body — a "json" rule_type must parse. */
export type TagRuleBodyResult = { ok: true; body: OrcaTagRule } | { ok: false; error: string }

/** Build the Orca tag-rule body from canvas fields (POST/PUT payload). */
export function buildCustomTagRuleBody(fields: Record<string, unknown>): TagRuleBodyResult {
  const ruleType = String(fields.ruleType ?? 'string').trim() || 'string'
  const rawRule = String(fields.rule ?? '').trim()

  let rule: unknown = rawRule
  if (ruleType === 'json') {
    try {
      rule = rawRule ? JSON.parse(rawRule) : {}
    } catch (e) {
      return { ok: false, error: `rule is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }

  return {
    ok: true,
    body: {
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
      tags: readKeyValueMap(fields.tags),
      rule,
      rule_type: ruleType,
      disabled: fields.disabled === true || fields.disabled === 'true',
    },
  }
}

/** Unwrap a `{ data: {...} }` envelope, returning null when absent. */
export function tagRuleFromEnvelope(payload: unknown): OrcaTagRule | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: OrcaTagRule }).data
  return data && typeof data === 'object' ? data : null
}

/** Unwrap the create response's `{ data: { tags_rule_id } }` envelope. */
export function createIdFromEnvelope(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: OrcaTagRuleCreateResponse }).data
  return data?.tags_rule_id ?? null
}
