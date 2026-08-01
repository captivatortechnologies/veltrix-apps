// Shared helpers for the PagerDuty Escalation Policies config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty escalation policy lives at /escalation_policies and is keyed for
// reconciliation by its `name` (PagerDuty assigns the server id). Each policy
// carries an ordered list of escalation RULES; each rule has a delay
// (escalation_delay_in_minutes) and one or more TARGETS. A target is an
// APIReference — { type, id } — where type is "user_reference" or
// "schedule_reference".
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's API reference and the official go-pagerduty client):
//   list:   GET    /escalation_policies        -> { escalation_policies: [...] }
//   create: POST   /escalation_policies        <- { escalation_policy: {...} }
//   get:    GET    /escalation_policies/{id}    -> { escalation_policy: {...} }
//   update: PUT    /escalation_policies/{id}    <- { escalation_policy: {...} }
//   delete: DELETE /escalation_policies/{id}
//
// Docs: https://developer.pagerduty.com/api-reference/b3A6Mjc0ODEyNQ-create-an-escalation-policy

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** Target reference types PagerDuty accepts on an escalation rule. */
export const VALID_TARGET_TYPES = new Set(['user_reference', 'schedule_reference'])

/** One escalation target — an APIReference to a user or an on-call schedule. */
export interface EscalationTarget {
  type: string
  id: string
}

/** One escalation rule: how long to wait, and who to page. */
export interface EscalationRuleSpec {
  escalation_delay_in_minutes: number
  targets: EscalationTarget[]
}

/** An escalation policy as returned by GET /escalation_policies. */
export interface LiveEscalationPolicy {
  id?: string
  type?: string
  name?: string
  description?: string
  num_loops?: number
  escalation_rules?: EscalationRuleSpec[]
}

/** One canvas item, normalized to the fields this config type manages. */
export interface EscalationPolicySpec {
  itemName: string
  name: string
  description: string
  /** num_loops as typed; null when the user left it blank (PagerDuty defaults it). */
  numLoops: number | null
  /** Raw JSON text for the escalation_rules array (required, non-empty array). */
  rulesJson: string
}

/**
 * Result of parsing the escalation_rules JSON. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `rules` and `error` are always-present nullable fields.
 */
export interface RulesParseResult {
  rules: EscalationRuleSpec[] | null
  error: string | null
}

/** Coerce num_loops from the canvas (number, numeric string, or blank). */
export function parseNumLoops(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : NaN
}

/**
 * Parse + shallow-validate the escalation_rules JSON. Returns the typed rules on
 * success, or a human-readable `error` describing the first problem. A blank input
 * is an error (rules are required and must be a non-empty array).
 */
export function parseEscalationRules(raw: string | undefined): RulesParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { rules: null, error: 'is required (a non-empty JSON array of rules)' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { rules: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { rules: null, error: 'must be a JSON array of rules' }
  if (parsed.length === 0) return { rules: null, error: 'must contain at least one escalation rule' }

  const rules: EscalationRuleSpec[] = []
  for (let i = 0; i < parsed.length; i++) {
    const rule = parsed[i] as Record<string, unknown>
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      return { rules: null, error: `rule ${i + 1} must be an object` }
    }
    const delay = rule.escalation_delay_in_minutes
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 1) {
      return { rules: null, error: `rule ${i + 1} needs a positive numeric "escalation_delay_in_minutes"` }
    }
    const targets = rule.targets
    if (!Array.isArray(targets) || targets.length === 0) {
      return { rules: null, error: `rule ${i + 1} needs a non-empty "targets" array` }
    }
    const cleanTargets: EscalationTarget[] = []
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t] as Record<string, unknown>
      const type = typeof target?.type === 'string' ? target.type.trim() : ''
      const id = typeof target?.id === 'string' ? target.id.trim() : ''
      if (!VALID_TARGET_TYPES.has(type)) {
        return {
          rules: null,
          error: `rule ${i + 1} target ${t + 1} "type" must be one of ${[...VALID_TARGET_TYPES].join(' / ')}`,
        }
      }
      if (!id) return { rules: null, error: `rule ${i + 1} target ${t + 1} needs an "id"` }
      cleanTargets.push({ type, id })
    }
    rules.push({ escalation_delay_in_minutes: delay, targets: cleanTargets })
  }
  return { rules, error: null }
}

/** Each canvas item describes one escalation policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): EscalationPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      numLoops: parseNumLoops(fields.num_loops),
      rulesJson: typeof fields.escalation_rules === 'string' ? fields.escalation_rules : '',
    }
  })
}

/**
 * Build the request body for POST/PUT /escalation_policies. Wrapped in an
 * `{ escalation_policy: {...} }` envelope by callers. `type` is set explicitly so
 * the API resolves the resource unambiguously.
 */
export function buildPolicyBody(spec: EscalationPolicySpec, rules: EscalationRuleSpec[]): LiveEscalationPolicy {
  const body: LiveEscalationPolicy = {
    type: 'escalation_policy',
    name: spec.name,
    escalation_rules: rules,
  }
  if (spec.description) body.description = spec.description
  if (spec.numLoops != null && Number.isFinite(spec.numLoops)) body.num_loops = spec.numLoops
  return body
}

/** Find a live policy by name (case-insensitive — the reconciliation identity). */
export function findPolicy(policies: LiveEscalationPolicy[], name: string): LiveEscalationPolicy | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return policies.find((p) => String(p.name ?? '').trim().toLowerCase() === n) ?? null
}
