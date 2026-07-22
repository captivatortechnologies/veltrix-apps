// =============================================================================
// Defender for Endpoint custom DETECTION RULES — spec model + validation.
//
// This config type manages scheduled KQL custom detection rules via the
// Microsoft Graph BETA API (/security/rules/detectionRules). It is a PREVIEW
// feature and is available only in the commercial cloud.
//
// Unlike the indicator config types (which share lib/indicators.ts), detection
// rules are self-contained in this directory: this module owns the spec model,
// the interfaces and the request-body builder, and the deploy / rollback /
// drift / health handlers import them from here.
//
// Identity is the CLIENT-PROVIDED rule id (e.g. "office-encoded-powershell"),
// which makes create idempotent-friendly — declared rules are matched to live
// rules by a case-insensitive id key. Graph severities are LOWERCASE
// (informational / low / medium / high), and rule state is expressed via
// `status` (enabled / disabled), which supersedes the deprecated `isEnabled`.
// =============================================================================

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** ISO-8601 run cadences the Graph schedule accepts (as offered on the canvas). */
export const RULE_FREQUENCIES = ['PT1H', 'PT3H', 'PT12H', 'P1D'] as const
/** Graph alert severities — LOWERCASE (unlike the indicators API's TitleCase). */
export const RULE_SEVERITIES = ['informational', 'low', 'medium', 'high'] as const
/** Authorable rule states. Graph also reports `autoDisabled`, but it is not authorable. */
export const RULE_STATUSES = ['enabled', 'disabled'] as const

/** Rule id: lowercase letters/digits/hyphens, starting with a letter or digit. */
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** One declared detection rule, extracted from a canvas item. */
export interface DetectionRuleSpec {
  sectionName: string
  ruleId: string
  displayName: string
  queryText: string
  frequency: string
  status: string
  alertTitle: string
  alertDescription: string
  alertSeverity: string
  alertCategory: string
  recommendedActions: string
}

/** A detection rule as returned by GET /security/rules/detectionRules. */
export interface LiveRule {
  id?: string
  displayName?: string
  status?: string
  queryCondition?: { queryText?: string }
  schedule?: { frequency?: string }
  detectionAction?: {
    alertTemplate?: {
      title?: string
      description?: string
      severity?: string
      category?: string
      recommendedActions?: string
    }
  }
  // Audit stamps used for drift attribution ("who changed it + when").
  createdBy?: string | null
  createdDateTime?: string | null
  lastModifiedBy?: string | null
  lastModifiedDateTime?: string | null
}

/** The case-insensitive id key — a detection rule's identity. */
export function ruleKey(id: string): string {
  return id.trim().toLowerCase()
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Each canvas item describes one detection rule. */
export function extractDetectionRuleSpecs(canvas: CanvasSnapshot): DetectionRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      ruleId: readString(fields.rule_id),
      displayName: readString(fields.display_name),
      queryText: readString(fields.query_text),
      frequency: readString(fields.frequency) || 'PT1H',
      status: readString(fields.status) || 'enabled',
      alertTitle: readString(fields.alert_title),
      alertDescription: readString(fields.alert_description),
      alertSeverity: readString(fields.alert_severity) || 'medium',
      alertCategory: readString(fields.alert_category),
      recommendedActions: readString(fields.recommended_actions),
    }
  })
}

/**
 * Build the Graph create/PATCH body for one spec. The `id` is intentionally
 * OMITTED: on PATCH it lives in the URL, and on POST the deploy handler prepends
 * the client-provided id. Optional alert fields are added only when present.
 */
export function buildRuleBody(spec: DetectionRuleSpec): Record<string, unknown> {
  const alertTemplate: Record<string, unknown> = {
    title: spec.alertTitle,
    description: spec.alertDescription,
    severity: spec.alertSeverity || 'medium',
  }
  if (spec.alertCategory) alertTemplate.category = spec.alertCategory
  if (spec.recommendedActions) alertTemplate.recommendedActions = spec.recommendedActions

  return {
    displayName: spec.displayName,
    queryCondition: { queryText: spec.queryText },
    schedule: { frequency: spec.frequency || 'PT1H' },
    status: spec.status || 'enabled',
    detectionAction: { alertTemplate },
  }
}

/** Reconstruct a spec from a live rule, so rollback can rebuild its body. */
export function ruleToSpec(rule: LiveRule): DetectionRuleSpec {
  const alert = rule.detectionAction?.alertTemplate ?? {}
  return {
    sectionName: rule.displayName ?? rule.id ?? '',
    ruleId: rule.id ?? '',
    displayName: rule.displayName ?? '',
    queryText: rule.queryCondition?.queryText ?? '',
    frequency: rule.schedule?.frequency ?? 'PT1H',
    status: rule.status ?? 'enabled',
    alertTitle: alert.title ?? '',
    alertDescription: alert.description ?? '',
    alertSeverity: alert.severity ?? 'medium',
    alertCategory: alert.category ?? '',
    recommendedActions: alert.recommendedActions ?? '',
  }
}

/**
 * Validate declared detection rules: each needs a valid client-chosen rule id,
 * a display name, a KQL query, an alert title and description; frequency,
 * severity and status must be from the supported sets; and the rule id is
 * unique (case-insensitive) across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no detection rules', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDetectionRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ruleId) {
      errors.push({ field: `${prefix}.rule_id`, message: 'Rule ID is required', code: 'required' })
    } else if (!RULE_ID_PATTERN.test(spec.ruleId)) {
      errors.push({
        field: `${prefix}.rule_id`,
        message: `Rule ID "${spec.ruleId}" must be lowercase letters, digits and hyphens (starting with a letter or digit)`,
        code: 'invalid_id',
      })
    }

    if (!spec.displayName) errors.push({ field: `${prefix}.display_name`, message: 'Display name is required', code: 'required' })
    if (!spec.queryText) errors.push({ field: `${prefix}.query_text`, message: 'Query text is required', code: 'required' })
    if (!spec.alertTitle) errors.push({ field: `${prefix}.alert_title`, message: 'Alert title is required', code: 'required' })
    if (!spec.alertDescription) errors.push({ field: `${prefix}.alert_description`, message: 'Alert description is required', code: 'required' })

    if (spec.frequency && !RULE_FREQUENCIES.includes(spec.frequency as (typeof RULE_FREQUENCIES)[number])) {
      errors.push({ field: `${prefix}.frequency`, message: `Unsupported frequency "${spec.frequency}"`, code: 'invalid_frequency' })
    }
    if (spec.alertSeverity && !RULE_SEVERITIES.includes(spec.alertSeverity as (typeof RULE_SEVERITIES)[number])) {
      errors.push({ field: `${prefix}.alert_severity`, message: `Unsupported severity "${spec.alertSeverity}" (Graph severities are lowercase)`, code: 'invalid_severity' })
    }
    if (spec.status && !RULE_STATUSES.includes(spec.status as (typeof RULE_STATUSES)[number])) {
      errors.push({ field: `${prefix}.status`, message: `Unsupported status "${spec.status}"`, code: 'invalid_status' })
    }

    if (spec.ruleId) {
      const key = ruleKey(spec.ruleId)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.rule_id`, message: `Duplicate rule ID "${spec.ruleId}"`, code: 'duplicate_rule' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
