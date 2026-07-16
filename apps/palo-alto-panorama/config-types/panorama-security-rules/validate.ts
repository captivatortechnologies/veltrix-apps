import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Panorama security rules live in the device-group PRE rulebase (evaluated
// before firewall-local rules). Shared pre-rules are also valid at location=shared.
export const RESOURCE_PATH = '/Policies/SecurityPreRules'

export const RULE_ACTIONS = ['allow', 'deny', 'drop'] as const
export type RuleAction = (typeof RULE_ACTIONS)[number]

export interface SecurityRuleSpec {
  sectionName: string
  name: string
  action: string
  fromZones: string[]
  toZones: string[]
  source: string[]
  destination: string[]
  application: string[]
  service: string[]
  description: string
  logSetting: string
  disabled: boolean
  profileGroup: string
}

export interface LiveSecurityRule extends PanoramaEntry {
  action?: string
  from?: { member?: string[] }
  to?: { member?: string[] }
  source?: { member?: string[] }
  destination?: { member?: string[] }
  application?: { member?: string[] }
  service?: { member?: string[] }
  description?: string
  'log-setting'?: string
  disabled?: string
  'profile-setting'?: { group?: { member?: string[] } }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

export function extractSecurityRuleSpecs(canvas: CanvasSnapshot): SecurityRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      action: str(fields.action) || 'allow',
      fromZones: splitList(fields.from_zones),
      toZones: splitList(fields.to_zones),
      source: splitList(fields.source),
      destination: splitList(fields.destination),
      application: splitList(fields.application),
      service: splitList(fields.service),
      description: str(fields.description),
      logSetting: str(fields.log_setting),
      disabled: coerceBoolean(fields.disabled, false),
      profileGroup: str(fields.profile_group),
    }
  })
}

/** The effective (defaulted) match fields, shared by build + drift. */
export function effectiveRule(spec: SecurityRuleSpec) {
  return {
    from: orDefault(spec.fromZones, ['any']),
    to: orDefault(spec.toZones, ['any']),
    source: orDefault(spec.source, ['any']),
    destination: orDefault(spec.destination, ['any']),
    application: orDefault(spec.application, ['any']),
    service: orDefault(spec.service, ['application-default']),
  }
}

/** Build the REST entry fields for a security pre-rule. */
export function buildSecurityRuleFields(spec: SecurityRuleSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  const fields: Record<string, unknown> = {
    from: { member: eff.from },
    to: { member: eff.to },
    source: { member: eff.source },
    destination: { member: eff.destination },
    application: { member: eff.application },
    service: { member: eff.service },
    action: spec.action,
    disabled: spec.disabled ? 'yes' : 'no',
  }
  if (spec.description) fields.description = spec.description
  if (spec.logSetting) fields['log-setting'] = spec.logSetting
  if (spec.profileGroup) fields['profile-setting'] = { group: { member: [spec.profileGroup] } }
  return fields
}

export function securityRuleUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractSecurityRuleSpecs(canvas)
    .filter((s) => s.name && RULE_ACTIONS.includes(s.action as RuleAction))
    .map((s) => ({ name: s.name, fields: buildSecurityRuleFields(s) }))
}

export function securityRuleDriftDiffs(spec: SecurityRuleSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveSecurityRule
  const eff = effectiveRule(spec)

  if (str(live.action) !== spec.action) {
    diffs.push({ field: `${spec.name}.action`, expected: spec.action, actual: str(live.action) || 'not set', severity: 'warning' })
  }

  const compareSet = (label: string, expected: string[], liveMember: string[] | undefined) => {
    const actual = Array.isArray(liveMember) ? liveMember : []
    if (!sameSet(actual, expected)) {
      diffs.push({ field: `${spec.name}.${label}`, expected: expected.join(', '), actual: actual.join(', ') || 'none', severity: 'info' })
    }
  }
  compareSet('from', eff.from, live.from?.member)
  compareSet('to', eff.to, live.to?.member)
  compareSet('source', eff.source, live.source?.member)
  compareSet('destination', eff.destination, live.destination?.member)
  compareSet('application', eff.application, live.application?.member)
  compareSet('service', eff.service, live.service?.member)

  const liveDisabled = str(live.disabled).toLowerCase() === 'yes'
  if (liveDisabled !== spec.disabled) {
    diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(liveDisabled), severity: 'info' })
  }
  return diffs
}

/**
 * Validate security pre-rules: a name and a supported action are required, and
 * the name is unique across the canvas. Zones, source, destination, application
 * and service default to "any"/"application-default" when left blank.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractSecurityRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }
    if (!RULE_ACTIONS.includes(spec.action as RuleAction)) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}" — use allow, deny or drop`, code: 'invalid_action' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate rule "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
