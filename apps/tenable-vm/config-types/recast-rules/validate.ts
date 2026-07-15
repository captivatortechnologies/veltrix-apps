import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Recast/Accept Rules API constraints -----------------------------

/** resource_type enum on the Recast Rules API. */
export const RESOURCE_TYPES = ['HOST', 'HOST_AUDIT', 'WEBAPP'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/** rule_value.action enum. RECAST changes a finding's severity; ACCEPT hides it. */
export const ACTIONS = ['RECAST', 'ACCEPT'] as const
export type Action = (typeof ACTIONS)[number]

/**
 * rule_value.severity enum. REQUIRED when action=RECAST (it is the recast
 * target severity) and FORBIDDEN/ignored when action=ACCEPT.
 */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

/** A plugin id is a positive integer (sent to the API as a string). */
export const PLUGIN_ID_PATTERN = /^\d+$/

/** expires_at is an ISO-8601 instant, e.g. 2026-12-31T23:59:59Z or with an offset. */
export const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface RecastRuleSpec {
  sectionName: string
  /**
   * Human label — this config type's CANVAS identity. The Recast API assigns no
   * name; live rules are matched by the (resource_type, pluginId, action) tuple
   * (see findRecastRule), so `name` is only used for the canvas UI, dedupe and
   * reporting.
   */
  name: string
  /** HOST | HOST_AUDIT | WEBAPP. */
  resourceType: string
  /** RECAST | ACCEPT. */
  action: string
  /** info|low|medium|high|critical — set only when action=RECAST. */
  severity?: string
  /** The plugin the rule targets (filter.plugin_id), as a numeric string. */
  pluginId: string
  /** Optional filter.host_targets (IPs / ranges / CIDRs / FQDNs). */
  hostTargets?: string
  /** Raw JSON string of extra filter keys, merged into filter; absent = none. */
  filterJson?: string
  /** Optional ISO-8601 expiry; absent = the rule never expires. */
  expiresAt?: string
}

/** Shape of a recast rule returned by GET /v1/recast/rules. */
export interface LiveRecastRule {
  rule_id?: string
  resource_type?: string
  rule_value?: {
    action?: string
    severity?: string
  } | null
  filter?: Record<string, unknown> | null
  expires_at?: string | null
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

/** Coerce a plugin_id field value (text or number) to a trimmed string. */
function toPluginId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

/**
 * Build the API `filter` object from a spec: always plugin_id, optional
 * host_targets, plus any keys from a valid filterJson merged on top. Does NOT
 * throw — an invalid filterJson is rejected by validate, and here it is simply
 * ignored so drift/deploy can still compute a base filter.
 */
export function buildRecastFilter(spec: RecastRuleSpec): Record<string, unknown> {
  const filter: Record<string, unknown> = { plugin_id: spec.pluginId }
  if (spec.hostTargets) filter.host_targets = spec.hostTargets
  if (spec.filterJson) {
    const extra = parseFilterObject(spec.filterJson)
    if (extra) Object.assign(filter, extra)
  }
  return filter
}

/** Each canvas item describes one Tenable recast/accept rule. */
export function extractRecastRuleSpecs(canvas: CanvasSnapshot): RecastRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const severity =
      typeof fields.severity === 'string' && fields.severity.trim()
        ? fields.severity.trim().toLowerCase()
        : undefined
    const hostTargets =
      typeof fields.host_targets === 'string' && fields.host_targets.trim()
        ? fields.host_targets.trim()
        : undefined
    const filterJson =
      typeof fields.filter_json === 'string' && fields.filter_json.trim()
        ? fields.filter_json.trim()
        : undefined
    const expiresAt =
      typeof fields.expires_at === 'string' && fields.expires_at.trim()
        ? fields.expires_at.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      resourceType:
        typeof fields.resource_type === 'string' ? fields.resource_type.trim().toUpperCase() : '',
      action: typeof fields.action === 'string' ? fields.action.trim().toUpperCase() : '',
      severity,
      pluginId: toPluginId(fields.plugin_id),
      hostTargets,
      filterJson,
      expiresAt,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate recast/accept rule configurations against the Recast Rules API:
 * a name, resource_type and action are required and enum-checked; severity is
 * REQUIRED for RECAST and FORBIDDEN for ACCEPT; plugin_id must be numeric; any
 * expires_at must be ISO-8601 and any filterJson must be a JSON object. Two
 * kinds of uniqueness are enforced across the canvas: the canvas identity
 * `name`, and the (resource_type, pluginId, action) tuple that deploy matches
 * live rules on — two items sharing a tuple would fight over the same rule.
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
  const seenTuples = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required + unique within the canvas (the canvas identity)
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

    // severity — enum when present; REQUIRED for RECAST, FORBIDDEN for ACCEPT
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
    if (spec.action === 'ACCEPT' && spec.severity) {
      errors.push({
        field: `${prefix}.severity`,
        message: 'Severity is not allowed when the action is ACCEPT — leave it unset',
        code: 'severity_not_allowed',
      })
    }

    // plugin_id — required + numeric
    if (!spec.pluginId) {
      errors.push({ field: `${prefix}.plugin_id`, message: 'Plugin ID is required', code: 'required' })
    } else if (!PLUGIN_ID_PATTERN.test(spec.pluginId)) {
      errors.push({
        field: `${prefix}.plugin_id`,
        message: 'Plugin ID must be a positive integer (e.g. 19506)',
        code: 'invalid_plugin_id',
      })
    }

    // filterJson — optional; when present it must parse as a JSON object
    if (spec.filterJson && parseFilterObject(spec.filterJson) === null) {
      errors.push({
        field: `${prefix}.filter_json`,
        message:
          'Filter JSON must be a valid JSON object, e.g. {"severity":["high","critical"]} — leave blank for none',
        code: 'invalid_filter_json',
      })
    }

    // expires_at — optional; when present it must be ISO-8601
    if (spec.expiresAt && !ISO8601_PATTERN.test(spec.expiresAt)) {
      errors.push({
        field: `${prefix}.expires_at`,
        message: 'Expiry must be an ISO-8601 instant, e.g. 2026-12-31T23:59:59Z',
        code: 'invalid_expires_at',
      })
    }

    // (resource_type, pluginId, action) is the live-match identity — dedupe on
    // it so two items don't converge on (and overwrite) the same live rule.
    if (spec.resourceType && spec.pluginId && spec.action) {
      const key = JSON.stringify([spec.resourceType, spec.pluginId, spec.action])
      if (seenTuples.has(key)) {
        errors.push({
          field: `${prefix}.plugin_id`,
          message: `Duplicate rule for ${spec.resourceType}/plugin ${spec.pluginId}/${spec.action} — this (resource type, plugin, action) may only be declared once per canvas`,
          code: 'duplicate_rule',
        })
      }
      seenTuples.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
