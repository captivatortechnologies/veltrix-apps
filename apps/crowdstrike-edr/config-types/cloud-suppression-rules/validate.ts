import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { LiveEntity } from '../../lib/entityAdapter'

// --- Cloud Security Suppression Rules API constraints -------------------------
//
// Verified against FalconPy `cloud_policies` (CreateSuppressionRule /
// QuerySuppressionRules). A suppression rule selects Cloud Security findings to
// suppress via a structured `rule_selection_filter` (which rules) plus a
// `scope_asset_filter` (which accounts/resources) — there is NO single free-text
// FQL "filter" field. `rule_selection_type` is all|specific; `scope_type` is
// account|resource. Identity is `name` (a queryable/sortable property).

export const RULE_SELECTION_TYPES = ['all', 'specific'] as const
export const SCOPE_TYPES = ['account', 'resource'] as const

/** Cloud rule severities are Title-cased on the API (Critical/High/Medium/Low). */
const SEVERITY_TITLE: Record<string, string> = {
  informational: 'Informational',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}

function titleCaseSeverity(value: string): string {
  const key = value.trim().toLowerCase()
  return SEVERITY_TITLE[key] ?? value.trim()
}

/** Only fully-qualified UTC timestamps ending in Z pass validation. */
export const EXPIRATION_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SuppressionSpec {
  sectionName: string
  name: string
  description?: string
  ruleSelectionType: string
  ruleSeverities: string[]
  ruleProviders: string[]
  ruleServices: string[]
  ruleIds: string[]
  scopeType: string
  accountIds: string[]
  cloudProviders: string[]
  regions: string[]
  resourceTypes: string[]
  suppressionReason?: string
  expiration?: string
  enabled: boolean
}

/** Structured filter objects returned by GET /cloud-policies/entities/suppression-rules/v1. */
export interface LiveRuleSelectionFilter {
  rule_ids?: string[]
  rule_names?: string[]
  rule_origins?: string[]
  rule_providers?: string[]
  rule_services?: string[]
  rule_severities?: string[]
}

export interface LiveScopeAssetFilter {
  account_ids?: string[]
  cloud_group_ids?: string[]
  cloud_providers?: string[]
  regions?: string[]
  resource_ids?: string[]
  resource_names?: string[]
  resource_types?: string[]
  service_categories?: string[]
  tags?: string[]
}

/** Shape of a suppression rule returned by the Cloud Security API. */
export interface LiveSuppressionRule extends LiveEntity {
  rule_selection_type?: string
  rule_selection_filter?: LiveRuleSelectionFilter
  scope_type?: string
  scope_asset_filter?: LiveScopeAssetFilter
  suppression_reason?: string
  suppression_expiration_date?: string
  disabled?: boolean
  created_by?: string
  last_modified_at?: string
}

/** Each canvas section describes one suppression rule. */
export function extractSuppressionSpecs(canvas: CanvasSnapshot): SuppressionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const expiration = typeof fields.expiration === 'string' ? fields.expiration.trim() : ''
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      ruleSelectionType:
        typeof fields.ruleSelectionType === 'string' && fields.ruleSelectionType.trim()
          ? fields.ruleSelectionType.trim().toLowerCase()
          : 'all',
      ruleSeverities: splitList(fields.ruleSeverities).map(titleCaseSeverity),
      ruleProviders: splitList(fields.ruleProviders).map((v) => v.toLowerCase()),
      ruleServices: splitList(fields.ruleServices),
      ruleIds: splitList(fields.ruleIds),
      scopeType:
        typeof fields.scopeType === 'string' && fields.scopeType.trim()
          ? fields.scopeType.trim().toLowerCase()
          : 'account',
      accountIds: splitList(fields.accountIds),
      cloudProviders: splitList(fields.cloudProviders).map((v) => v.toLowerCase()),
      regions: splitList(fields.regions),
      resourceTypes: splitList(fields.resourceTypes),
      suppressionReason:
        typeof fields.suppressionReason === 'string' && fields.suppressionReason.trim()
          ? fields.suppressionReason.trim()
          : undefined,
      expiration: expiration.length > 0 ? expiration : undefined,
      enabled: coerceBoolean(fields.enabled, true),
    }
  })
}

/** True when the rule selects at least one thing to suppress. */
export function hasRuleSelection(spec: SuppressionSpec): boolean {
  return (
    spec.ruleSeverities.length > 0 ||
    spec.ruleProviders.length > 0 ||
    spec.ruleServices.length > 0 ||
    spec.ruleIds.length > 0
  )
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate suppression rule configurations against Cloud Security API
 * constraints: a unique name, a non-empty rule selection (a suppression that
 * matches nothing is meaningless), recognized selection/scope types, and a
 * well-formed UTC expiration.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSuppressionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Suppression rule name is required', code: 'required' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate suppression rule "${spec.name}" — each name may only be declared once per canvas`,
        code: 'duplicate_suppression',
      })
    }
    seen.add(spec.name.toLowerCase())

    // rule selection — the suppression must actually select findings
    if (!hasRuleSelection(spec)) {
      errors.push({
        field: `${prefix}.ruleSeverities`,
        message:
          'A suppression rule must select at least one thing to suppress — set rule severities, providers, services, or rule IDs',
        code: 'empty_selection',
      })
    }

    // selection / scope type
    if (!(RULE_SELECTION_TYPES as readonly string[]).includes(spec.ruleSelectionType)) {
      errors.push({
        field: `${prefix}.ruleSelectionType`,
        message: `Rule selection type must be one of: ${RULE_SELECTION_TYPES.join(', ')}`,
        code: 'invalid_selection_type',
      })
    }
    if (!(SCOPE_TYPES as readonly string[]).includes(spec.scopeType)) {
      errors.push({
        field: `${prefix}.scopeType`,
        message: `Scope type must be one of: ${SCOPE_TYPES.join(', ')}`,
        code: 'invalid_scope_type',
      })
    }

    // expiration
    if (spec.expiration !== undefined) {
      if (!EXPIRATION_UTC_RE.test(spec.expiration)) {
        errors.push({
          field: `${prefix}.expiration`,
          message: 'Expiration must be an ISO-8601 UTC timestamp ending in Z, e.g. 2026-12-31T00:00:00Z',
          code: 'invalid_format',
        })
      } else if (Date.parse(spec.expiration) <= Date.now()) {
        warnings.push({
          field: `${prefix}.expiration`,
          message: 'Expiration is in the past — this suppression rule will not suppress anything',
          code: 'expired',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
