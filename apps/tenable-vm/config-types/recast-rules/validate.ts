import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Recast/Accept Rules API constraints -----------------------------
//
// developer.tenable.com/reference/recast-rules-create (POST /v1/recast/rules)
// and .../recast-rules-update (PUT /v1/recast/rules/{rule_id}): the create/
// update body is `{ rule_name, description?, resource_type, rule_value, filter,
// expires_at?, disabled_details? }`. There is no plain GET list — rules are
// listed via POST /v1/recast/rules/search (see deploy.ts's findRecastRule).

/** resource_type enum on the Recast Rules API. */
export const RESOURCE_TYPES = ['HOST', 'HOST_AUDIT', 'WEBAPP'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/**
 * rule_value.action enum. RECAST/ACCEPT apply to Vulnerabilities and Web
 * Applications (resource_type HOST/WEBAPP); CHANGE_RESULT/ACCEPT_RESULT apply
 * to Host Audits (resource_type HOST_AUDIT) instead — the two families are
 * mutually exclusive per resource_type.
 */
export const ACTIONS = ['RECAST', 'ACCEPT', 'CHANGE_RESULT', 'ACCEPT_RESULT'] as const
export type Action = (typeof ACTIONS)[number]

/** Actions valid for resource_type HOST or WEBAPP. */
export const VULN_ACTIONS: readonly string[] = ['RECAST', 'ACCEPT']
/** Actions valid for resource_type HOST_AUDIT. */
export const AUDIT_ACTIONS: readonly string[] = ['CHANGE_RESULT', 'ACCEPT_RESULT']

/**
 * rule_value.severity enum (values are CASE SENSITIVE on the live API).
 * REQUIRED when action=RECAST (it is the recast target severity); forbidden
 * for every other action.
 */
export const SEVERITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]

/**
 * rule_value.compliance_result enum. REQUIRED when action=CHANGE_RESULT (the
 * reassigned Host Audit result); forbidden for every other action.
 */
export const COMPLIANCE_RESULTS = ['PASSED', 'FAILED', 'WARNING'] as const
export type ComplianceResult = (typeof COMPLIANCE_RESULTS)[number]

/** expires_at is an ISO-8601 instant, e.g. 2026-12-31T23:59:59Z or with an offset. */
export const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface RecastRuleSpec {
  sectionName: string
  /** Sent as the API's `rule_name` — also this config type's match/identity key. */
  name: string
  description?: string
  /** HOST | HOST_AUDIT | WEBAPP. */
  resourceType: string
  /** RECAST | ACCEPT | CHANGE_RESULT | ACCEPT_RESULT. */
  action: string
  /** NONE|LOW|MEDIUM|HIGH|CRITICAL — set only when action=RECAST. */
  severity?: string
  /** PASSED|FAILED|WARNING — set only when action=CHANGE_RESULT. */
  complianceResult?: string
  /** Optional notes/rationale (rule_value.comment). */
  comment?: string
  /** Optional false-positive flag (rule_value.false_positive). */
  falsePositive?: boolean
  /**
   * Raw JSON string of the API's `filter` object — REQUIRED, and must be
   * exactly `{"and":[{"property","operator","value"}, ...]}` or the `"or"`
   * equivalent (see developer.tenable.com/reference/recast-rules-filters-list
   * for the per-resource-type property catalog).
   */
  filterJson: string
  /** Optional ISO-8601 expiry; absent = the rule never expires. */
  expiresAt?: string
  /** Optional: pause the rule without deleting it (disabled_details.disabled). */
  disabled?: boolean
  /** Optional explanation shown alongside a disabled rule. */
  disabledReason?: string
}

/**
 * Shape of a recast rule as returned by POST /v1/recast/rules/search (list)
 * and GET /v1/recast/rules/{rule_id} (detail) — both surface the same fields.
 */
export interface LiveRecastRule {
  rule_id?: string
  rule_name?: string
  description?: string
  resource_type?: string
  rule_value?: {
    action?: string
    severity?: string
    compliance_result?: string
    comment?: string
    false_positive?: boolean
  } | null
  filter?: Record<string, unknown> | null
  expires_at?: string | null
  disabled_details?: { disabled?: boolean; disabled_reason?: string } | null
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not
 * a JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy/drift (to build the filter body).
 */
export function parseFilterObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/**
 * Check a parsed filter object against the API's real shape: it must have
 * EXACTLY one of "and" / "or" as a key, whose value is a non-empty array of
 * `{property, operator, value}` condition objects (matching the `oneOf`
 * schema on developer.tenable.com/reference/recast-rules-create).
 */
export function isValidRecastFilterShape(filter: Record<string, unknown>): boolean {
  const hasAnd = Array.isArray(filter.and)
  const hasOr = Array.isArray(filter.or)
  if (hasAnd === hasOr) return false // must have exactly one, not both/neither
  const conditions = (hasAnd ? filter.and : filter.or) as unknown[]
  if (conditions.length === 0) return false
  return conditions.every(
    (c) => c !== null && typeof c === 'object' && typeof (c as Record<string, unknown>).property === 'string',
  )
}

/** Each canvas item describes one Tenable recast/accept rule. */
export function extractRecastRuleSpecs(canvas: CanvasSnapshot): RecastRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const severity =
      typeof fields.severity === 'string' && fields.severity.trim()
        ? fields.severity.trim().toUpperCase()
        : undefined
    const complianceResult =
      typeof fields.compliance_result === 'string' && fields.compliance_result.trim()
        ? fields.compliance_result.trim().toUpperCase()
        : undefined
    const comment =
      typeof fields.comment === 'string' && fields.comment.trim() ? fields.comment.trim() : undefined
    const falsePositive = typeof fields.false_positive === 'boolean' ? fields.false_positive : undefined
    const filterJson =
      typeof fields.filter_json === 'string' && fields.filter_json.trim()
        ? fields.filter_json.trim()
        : ''
    const expiresAt =
      typeof fields.expires_at === 'string' && fields.expires_at.trim()
        ? fields.expires_at.trim()
        : undefined
    const disabled = typeof fields.disabled === 'boolean' ? fields.disabled : undefined
    const disabledReason =
      typeof fields.disabled_reason === 'string' && fields.disabled_reason.trim()
        ? fields.disabled_reason.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      resourceType:
        typeof fields.resource_type === 'string' ? fields.resource_type.trim().toUpperCase() : '',
      action: typeof fields.action === 'string' ? fields.action.trim().toUpperCase() : '',
      severity,
      complianceResult,
      comment,
      falsePositive,
      filterJson,
      expiresAt,
      disabled,
      disabledReason,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate recast/accept rule configurations against the Recast Rules API:
 * a name, resource_type, action and filter are required; action must be
 * compatible with resource_type (RECAST/ACCEPT for HOST/WEBAPP,
 * CHANGE_RESULT/ACCEPT_RESULT for HOST_AUDIT); severity is REQUIRED for
 * RECAST and FORBIDDEN otherwise; compliance_result is REQUIRED for
 * CHANGE_RESULT and FORBIDDEN otherwise; filter must be valid JSON matching
 * the `{"and":[...]}` / `{"or":[...]}` shape; any expires_at must be
 * ISO-8601. name — the canvas identity AND the live rule_name this deploys
 * matches on — must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRecastRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required + unique within the canvas (the canvas identity AND the
    // live rule_name this deploys matches existing rules on)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule name "${spec.name}" — each rule name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // resource_type — required + enum
    if (!spec.resourceType) {
      errors.push({ field: `${prefix}.resource_type`, message: 'Resource type is required', code: 'required' })
    } else if (!(RESOURCE_TYPES as readonly string[]).includes(spec.resourceType)) {
      errors.push({
        field: `${prefix}.resource_type`,
        message: `Resource type must be one of: ${RESOURCE_TYPES.join(', ')}`,
        code: 'invalid_resource_type',
      })
    }

    // action — required + enum
    if (!spec.action) {
      errors.push({ field: `${prefix}.action`, message: 'Action is required', code: 'required' })
    } else if (!(ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({
        field: `${prefix}.action`,
        message: `Action must be one of: ${ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }

    // action must be compatible with resource_type: RECAST/ACCEPT target
    // Vulnerabilities/Web Applications (HOST/WEBAPP); CHANGE_RESULT/ACCEPT_RESULT
    // target Host Audits (HOST_AUDIT). Tenable rejects the mismatched pairing.
    if (spec.resourceType && spec.action) {
      if (spec.resourceType === 'HOST_AUDIT' && !AUDIT_ACTIONS.includes(spec.action)) {
        errors.push({
          field: `${prefix}.action`,
          message: `Host Audit rules require action CHANGE_RESULT or ACCEPT_RESULT, not ${spec.action}`,
          code: 'incompatible_action',
        })
      } else if (spec.resourceType !== 'HOST_AUDIT' && !VULN_ACTIONS.includes(spec.action)) {
        errors.push({
          field: `${prefix}.action`,
          message: `${spec.resourceType} rules require action RECAST or ACCEPT, not ${spec.action}`,
          code: 'incompatible_action',
        })
      }
    }

    // severity — enum when present; REQUIRED for RECAST, FORBIDDEN otherwise
    if (spec.severity && !(SEVERITIES as readonly string[]).includes(spec.severity)) {
      errors.push({
        field: `${prefix}.severity`,
        message: `Severity must be one of: ${SEVERITIES.join(', ')}`,
        code: 'invalid_severity',
      })
    }
    if (spec.action === 'RECAST' && !spec.severity) {
      errors.push({
        field: `${prefix}.severity`,
        message: 'Severity is required when the action is RECAST (it is the recast target severity)',
        code: 'required',
      })
    }
    if (spec.action && spec.action !== 'RECAST' && spec.severity) {
      errors.push({
        field: `${prefix}.severity`,
        message: 'Severity is only allowed when the action is RECAST — leave it unset',
        code: 'severity_not_allowed',
      })
    }

    // compliance_result — enum when present; REQUIRED for CHANGE_RESULT, FORBIDDEN otherwise
    if (spec.complianceResult && !(COMPLIANCE_RESULTS as readonly string[]).includes(spec.complianceResult)) {
      errors.push({
        field: `${prefix}.compliance_result`,
        message: `Compliance result must be one of: ${COMPLIANCE_RESULTS.join(', ')}`,
        code: 'invalid_compliance_result',
      })
    }
    if (spec.action === 'CHANGE_RESULT' && !spec.complianceResult) {
      errors.push({
        field: `${prefix}.compliance_result`,
        message: 'Compliance result is required when the action is CHANGE_RESULT',
        code: 'required',
      })
    }
    if (spec.action && spec.action !== 'CHANGE_RESULT' && spec.complianceResult) {
      errors.push({
        field: `${prefix}.compliance_result`,
        message: 'Compliance result is only allowed when the action is CHANGE_RESULT — leave it unset',
        code: 'compliance_result_not_allowed',
      })
    }

    // filter — required; must be a JSON object matching {"and":[...]} or {"or":[...]}
    if (!spec.filterJson) {
      errors.push({
        field: `${prefix}.filter_json`,
        message: 'Filter is required — the rule needs at least one targeting condition',
        code: 'required',
      })
    } else {
      const parsedFilter = parseFilterObject(spec.filterJson)
      if (parsedFilter === null || !isValidRecastFilterShape(parsedFilter)) {
        errors.push({
          field: `${prefix}.filter_json`,
          message:
            'Filter must be a JSON object shaped {"and":[{"property":"definition.id","operator":"eq","value":"19506"}]} ' +
            '(or "or" instead of "and") — see GET /v1/recast/rules/filters for valid property names per resource type',
          code: 'invalid_filter_json',
        })
      }
    }

    // expires_at — optional; when present it must be ISO-8601
    if (spec.expiresAt && !ISO8601_PATTERN.test(spec.expiresAt)) {
      errors.push({
        field: `${prefix}.expires_at`,
        message: 'Expiry must be an ISO-8601 instant, e.g. 2026-12-31T23:59:59Z',
        code: 'invalid_expires_at',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
