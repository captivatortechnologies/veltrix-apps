import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne Firewall Control constraints --------------------------------
// Source: SentinelOne Management API v2.1 `/firewall-control` (Control SKU).
// Field enums below are taken from the collection's own list-filter parameters
// (actions, directions, osTypes, statuses), which this API consistently names
// after the object's own fields (singular in the write body, plural as the list
// filter) — the same inference this app already relies on for exclusions/
// restrictions/STAR rules. See config-types/s1-firewall-rules/deploy.ts for the
// cited sources.

export const ACTIONS = ['Allow', 'Blocked'] as const
export const DIRECTIONS = ['any', 'inbound', 'outbound'] as const
export const OS_TYPES = ['windows', 'windows_legacy', 'linux', 'macos'] as const
export const STATUSES = ['Enabled', 'Disabled'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface FirewallRuleSpec {
  sectionName: string
  name: string
  description?: string
  action: string
  direction: string
  osType: string
  protocol?: string
  application?: string
  service?: string
  status: string
}

/** Shape of a rule returned by GET /firewall-control. */
export interface LiveFirewallRule {
  id?: string
  name?: string
  description?: string
  action?: string
  direction?: string
  osType?: string
  protocol?: string
  application?: string
  service?: string
  status?: string
}

/**
 * The rule's logical identity at a scope: its name. Case-insensitive and
 * trimmed, matching how this app already reconciles SentinelOne STAR rules
 * (SentinelOne does not enforce rule-name uniqueness server-side, so this app
 * enforces it client-side for a stable natural key).
 */
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one SentinelOne Firewall Control rule. */
export function extractFirewallRuleSpecs(canvas: CanvasSnapshot): FirewallRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const optStr = (value: unknown): string | undefined => str(value) || undefined
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: optStr(fields.description),
      action: str(fields.action) || 'Allow',
      direction: str(fields.direction) || 'any',
      osType: str(fields.os_type) || 'windows',
      protocol: optStr(fields.protocol),
      application: optStr(fields.application),
      service: optStr(fields.service),
      status: str(fields.status) || 'Enabled',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Firewall Control rule configurations against SentinelOne
 * constraints: name is required; action, direction, OS and status must be from
 * the supported sets; and the rule name (case-insensitive) must be unique
 * across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFirewallRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }
    if (!ACTIONS.includes(spec.action as (typeof ACTIONS)[number])) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!DIRECTIONS.includes(spec.direction as (typeof DIRECTIONS)[number])) {
      errors.push({ field: `${prefix}.direction`, message: `Unsupported direction "${spec.direction}"`, code: 'invalid_direction' })
    }
    if (!OS_TYPES.includes(spec.osType as (typeof OS_TYPES)[number])) {
      errors.push({ field: `${prefix}.os_type`, message: `Unsupported OS "${spec.osType}"`, code: 'invalid_os' })
    }
    if (!STATUSES.includes(spec.status as (typeof STATUSES)[number])) {
      errors.push({ field: `${prefix}.status`, message: `Unsupported status "${spec.status}"`, code: 'invalid_status' })
    }
    if (!spec.application && !spec.protocol && !spec.service) {
      warnings.push({
        field: `${prefix}.application`,
        message:
          'No application, protocol or service is set — this rule matches ALL traffic for its direction/OS, which is only intended for a single clean-up rule at the end of the list',
        code: 'unscoped_rule',
      })
    }

    if (spec.name) {
      const key = ruleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
