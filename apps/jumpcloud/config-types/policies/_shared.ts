// Shared helpers for the JumpCloud Policies config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Policies are applied over the JumpCloud API v2 (/policies) and are
// TEMPLATE-BASED: every policy is an instance of a Policy Template (GET
// /api/v2/policytemplates) whose configurable fields are supplied as `values`.
//
// VERIFIED against the jcapi v2 model docs:
//   - Endpoints: GET/POST /policies, GET/PUT/DELETE /policies/{id}
//   - PolicyRequest body: `name` (required), `template` (PolicyRequestTemplate,
//     i.e. { id }), `values` (list[PolicyValue]); PolicyValue carries
//     `configFieldID` (verified) alongside `configFieldName` + `value`.
// FLAGGED — verify against a live JumpCloud tenant:
//   - The exact PolicyValue wire shape (`configFieldName` / `value` are not in
//     the jcapi PolicyValue excerpt, only `config_field_id`).
//   - Whether PolicyRequest accepts `active` on create/update (the Policy
//     RESPONSE model exposes `active`, but the request model excerpt lists only
//     name/template/values). It is sent best-effort here.
//   - Each template's required config-field ids — only the operator's tenant
//     knows them, so `values` is authored as raw JSON.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** One item of a policy's `values` array (the value for one template config field). */
export interface JumpCloudPolicyValue {
  configFieldID?: string
  configFieldName?: string
  value?: unknown
  [key: string]: unknown
}

/** One JumpCloud Policy as returned by GET /policies and GET /policies/{id}. */
export interface JumpCloudPolicy {
  id?: string
  name?: string
  /** Template reference — an object carrying at least `id` on the wire. */
  template?: { id?: string; [key: string]: unknown } | string
  values?: JumpCloudPolicyValue[]
  active?: boolean
  [key: string]: unknown
}

/** The desired state for one Policy, extracted from a canvas item. */
export interface PolicySpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** Policy name — the logical identity live policies are matched on. */
  name: string
  /** Policy Template ObjectId this policy instantiates (required to create). */
  templateId: string
  /** Whether the policy should be active (sent best-effort — FLAGGED). */
  active: boolean
  /** Raw `values` JSON exactly as typed in the canvas (for validation messages). */
  valuesRaw: string
}

/** Coerce a checkbox-ish value to a boolean (defaults true — policies deploy active). */
export function normalizeActive(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === '') return true
  return true
}

/** Each canvas item describes one JumpCloud Policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      templateId: String(fields.templateId ?? '').trim(),
      active: normalizeActive(fields.active),
      valuesRaw: String(fields.values ?? '').trim(),
    }
  })
}

export interface ParsedValues {
  values: JumpCloudPolicyValue[]
  error?: string
}

/**
 * Parse the raw `values` JSON into a PolicyValue array. An empty string is a
 * valid empty list (a policy may take template defaults). Returns an `error`
 * string instead of throwing on malformed / wrong-shaped content so validate.ts
 * can surface it as a field error.
 */
export function parsePolicyValues(raw: string): ParsedValues {
  const text = raw.trim()
  if (!text) return { values: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { values: [], error: `values is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) {
    return { values: [], error: 'values must be a JSON array of { configFieldID, configFieldName, value } objects.' }
  }
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { values: [], error: `values[${i}] must be an object with configFieldID / configFieldName / value.` }
    }
    const hasId = 'configFieldID' in (row as object) || 'configFieldName' in (row as object)
    if (!hasId) {
      return { values: [], error: `values[${i}] must set configFieldID or configFieldName.` }
    }
  }
  return { values: parsed as JumpCloudPolicyValue[] }
}

/** Find a live Policy by name (case-insensitive — the stable identity). */
export function findPolicyByName(policies: JumpCloudPolicy[], name: string): JumpCloudPolicy | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return policies.find((p) => String(p.name ?? '').trim().toLowerCase() === target) ?? null
}

/** Extract a template id from a policy's `template` field (object or bare string). */
export function templateIdOf(policy: JumpCloudPolicy): string {
  const t = policy.template
  if (!t) return ''
  return typeof t === 'string' ? t : String(t.id ?? '')
}

/**
 * Build the JumpCloud Policy body for POST/PUT /policies (PolicyRequest):
 * `name` + `template: { id }` + `values`. `active` is sent best-effort (FLAGGED
 * — the request model's acceptance of it is unverified).
 */
export function buildPolicyBody(spec: PolicySpec, values: JumpCloudPolicyValue[]): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, values }
  if (spec.templateId) body.template = { id: spec.templateId }
  body.active = spec.active
  return body
}

/** The subset of a live policy's fields this config type manages — captured for rollback. */
export function priorFieldsOf(policy: JumpCloudPolicy): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(policy.name ?? ''),
    values: Array.isArray(policy.values) ? policy.values : [],
  }
  const templateId = templateIdOf(policy)
  if (templateId) body.template = { id: templateId }
  if (typeof policy.active === 'boolean') body.active = policy.active
  return body
}
