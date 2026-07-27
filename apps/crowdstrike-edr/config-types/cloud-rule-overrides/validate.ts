import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { LiveEntity } from '../../lib/entityAdapter'

// --- Cloud Security Rule Overrides API constraints ---------------------------
//
// Verified against FalconPy `cloud_policies` (CreateRuleOverride /
// UpdateRuleOverride). A rule override adjusts a BUILT-IN Cloud Security policy
// rule for a given scope. The write body is wrapped:
//   { "overrides": [ { rule_id, override_type, overrides_details, crn,
//                      target_region, comment, reason, expires_at } ] }
// The override is keyed by `rule_id` (+ optional `crn` cloud-account scope).
// NOTE: this collection has NO queries endpoint — existing overrides are read by
// id via GET /cloud-policies/entities/rule-overrides/v1?ids=... (see deploy.ts).

/** Override types observed in the API; "exception" suppresses the rule for a scope. */
export const OVERRIDE_TYPES = ['exception'] as const

/** Only fully-qualified UTC timestamps ending in Z pass validation. */
export const EXPIRES_AT_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface OverrideSpec {
  sectionName: string
  ruleId: string
  overrideType: string
  overrideDetails?: string
  reason?: string
  comment?: string
  crn?: string
  targetRegion?: string
  expiresAt?: string
}

/** Shape of a rule override returned by GET /cloud-policies/entities/rule-overrides/v1. */
export interface LiveRuleOverride extends LiveEntity {
  rule_id?: string
  override_type?: string
  overrides_details?: string
  reason?: string
  comment?: string
  crn?: string
  target_region?: string
  expires_at?: string
  modified_at?: string
  updated_at?: string
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optional(value: unknown): string | undefined {
  const v = trimmed(value)
  return v.length > 0 ? v : undefined
}

/** Each canvas section describes one rule override. */
export function extractOverrideSpecs(canvas: CanvasSnapshot): OverrideSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      ruleId: trimmed(fields.ruleId),
      overrideType: trimmed(fields.overrideType) || 'exception',
      overrideDetails: optional(fields.overrideDetails),
      reason: optional(fields.reason),
      comment: optional(fields.comment),
      crn: optional(fields.crn),
      targetRegion: optional(fields.targetRegion),
      expiresAt: optional(fields.expiresAt),
    }
  })
}

/** The identity of an override: its rule id, scoped by crn when present. */
export function overrideKey(spec: OverrideSpec): string {
  return spec.crn ? `${spec.ruleId}|${spec.crn}` : spec.ruleId
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate rule override configurations against Cloud Security API constraints:
 * a required rule id, a recognized override type, unique (rule id + scope), and
 * a well-formed UTC expiration.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractOverrideSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // rule id (identity)
    if (!spec.ruleId) {
      errors.push({
        field: `${prefix}.ruleId`,
        message: 'Rule ID of the built-in rule to override is required',
        code: 'required',
      })
    } else {
      const key = overrideKey(spec).toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.ruleId`,
          message: `Duplicate override for rule "${spec.ruleId}"${
            spec.crn ? ` (scope ${spec.crn})` : ''
          } — each rule/scope may only be overridden once per canvas`,
          code: 'duplicate_override',
        })
      }
      seen.add(key)
    }

    // override type
    if (!spec.overrideType) {
      errors.push({
        field: `${prefix}.overrideType`,
        message: 'Override type is required',
        code: 'required',
      })
    } else if (!(OVERRIDE_TYPES as readonly string[]).includes(spec.overrideType.toLowerCase())) {
      warnings.push({
        field: `${prefix}.overrideType`,
        message: `Override type "${spec.overrideType}" is not a verified value (known: ${OVERRIDE_TYPES.join(
          ', ',
        )})`,
        code: 'unverified_override_type',
      })
    }

    // expiration
    if (spec.expiresAt !== undefined) {
      if (!EXPIRES_AT_UTC_RE.test(spec.expiresAt)) {
        errors.push({
          field: `${prefix}.expiresAt`,
          message: 'Expiration must be an ISO-8601 UTC timestamp ending in Z, e.g. 2026-12-31T00:00:00Z',
          code: 'invalid_format',
        })
      } else if (Date.parse(spec.expiresAt) <= Date.now()) {
        warnings.push({
          field: `${prefix}.expiresAt`,
          message: 'Expiration is in the past — this override will not apply',
          code: 'expired',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
