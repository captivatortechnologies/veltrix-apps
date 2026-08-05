import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Authentication rules (/Policies/AuthenticationPreRules) — the device-group
// PRE rulebase decides which traffic must pass a Captive Portal / MFA
// challenge before it is allowed to continue. Cited: PAN-OS REST API
// "Policies" category; class AuthenticationRules in pypanrestv2
// (github.com/mrzepa/pypanrestv2, Policies.py) resolves to REST path
// "<class>".split('Rules')[0] + rulebase + "Rules" (the same convention this
// app's panorama-security-rules / panorama-nat-rules already use) =>
// AuthenticationPreRules; and terraform-provider-panos
// panos_authentication_policy_rules (rules[].{source_zones,source_addresses,
// source_users,destination_zones,destination_addresses,services,category,
// authentication_enforcement,timeout,log_authentication_timeout,log_setting}).
//
// `authentication_enforcement` references an Authentication Enforcement object
// (/Objects/AuthenticationEnforcements, itself pointing at a Device-category,
// template-scoped Authentication Profile) BY NAME — neither is authored by
// this app (same free-text-reference precedent as security-rules'
// "profile_group" / "log_setting"); it must already exist in Panorama.
export const RESOURCE_PATH = '/Policies/AuthenticationPreRules'

export interface AuthenticationRuleSpec {
  sectionName: string
  name: string
  sourceZones: string[]
  destinationZones: string[]
  sourceAddresses: string[]
  destinationAddresses: string[]
  sourceUsers: string[]
  service: string[]
  category: string[]
  authenticationEnforcement: string
  timeout: number
  logAuthenticationTimeout: boolean
  logSetting: string
  disabled: boolean
  description: string
}

export interface LiveAuthenticationRule extends PanoramaEntry {
  from?: { member?: string[] }
  to?: { member?: string[] }
  source?: { member?: string[] }
  destination?: { member?: string[] }
  'source-user'?: { member?: string[] }
  service?: { member?: string[] }
  category?: { member?: string[] }
  'authentication-enforcement'?: string
  timeout?: number | string
  'log-authentication-timeout'?: string
  'log-setting'?: string
  disabled?: string
  description?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function extractAuthenticationRuleSpecs(canvas: CanvasSnapshot): AuthenticationRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      sourceZones: splitList(fields.source_zones),
      destinationZones: splitList(fields.destination_zones),
      sourceAddresses: splitList(fields.source_addresses),
      destinationAddresses: splitList(fields.destination_addresses),
      sourceUsers: splitList(fields.source_users),
      service: splitList(fields.service),
      category: splitList(fields.category),
      authenticationEnforcement: str(fields.authentication_enforcement),
      timeout: num(fields.timeout, 60),
      logAuthenticationTimeout: coerceBoolean(fields.log_authentication_timeout, true),
      logSetting: str(fields.log_setting),
      disabled: coerceBoolean(fields.disabled, false),
      description: str(fields.description),
    }
  })
}

/** The effective (defaulted) match fields, shared by build + drift. */
export function effectiveRule(spec: AuthenticationRuleSpec) {
  return {
    from: orDefault(spec.sourceZones, ['any']),
    to: orDefault(spec.destinationZones, ['any']),
    source: orDefault(spec.sourceAddresses, ['any']),
    destination: orDefault(spec.destinationAddresses, ['any']),
    sourceUser: orDefault(spec.sourceUsers, ['any']),
    service: orDefault(spec.service, ['any']),
    category: orDefault(spec.category, ['any']),
  }
}

/** Build the REST entry fields for an authentication pre-rule. */
export function buildAuthenticationRuleFields(spec: AuthenticationRuleSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  const fields: Record<string, unknown> = {
    from: { member: eff.from },
    to: { member: eff.to },
    source: { member: eff.source },
    destination: { member: eff.destination },
    'source-user': { member: eff.sourceUser },
    service: { member: eff.service },
    category: { member: eff.category },
    'authentication-enforcement': spec.authenticationEnforcement,
    timeout: spec.timeout,
    'log-authentication-timeout': spec.logAuthenticationTimeout ? 'yes' : 'no',
    disabled: spec.disabled ? 'yes' : 'no',
  }
  if (spec.logSetting) fields['log-setting'] = spec.logSetting
  if (spec.description) fields.description = spec.description
  return fields
}

export function authenticationRuleUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractAuthenticationRuleSpecs(canvas)
    .filter((s) => s.name && s.authenticationEnforcement)
    .map((s) => ({ name: s.name, fields: buildAuthenticationRuleFields(s) }))
}

export function authenticationRuleDriftDiffs(spec: AuthenticationRuleSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveAuthenticationRule
  const eff = effectiveRule(spec)

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
  compareSet('source-user', eff.sourceUser, live['source-user']?.member)
  compareSet('service', eff.service, live.service?.member)
  compareSet('category', eff.category, live.category?.member)

  if (str(live['authentication-enforcement']) !== spec.authenticationEnforcement) {
    diffs.push({
      field: `${spec.name}.authentication-enforcement`,
      expected: spec.authenticationEnforcement,
      actual: str(live['authentication-enforcement']) || 'not set',
      severity: 'critical',
    })
  }
  if (num(live.timeout, -1) !== spec.timeout) {
    diffs.push({ field: `${spec.name}.timeout`, expected: String(spec.timeout), actual: String(live.timeout ?? 'not set'), severity: 'warning' })
  }
  const liveLogTimeout = str(live['log-authentication-timeout']).toLowerCase() === 'yes'
  if (liveLogTimeout !== spec.logAuthenticationTimeout) {
    diffs.push({ field: `${spec.name}.log-authentication-timeout`, expected: String(spec.logAuthenticationTimeout), actual: String(liveLogTimeout), severity: 'info' })
  }
  if (spec.logSetting && str(live['log-setting']) !== spec.logSetting) {
    diffs.push({ field: `${spec.name}.log-setting`, expected: spec.logSetting, actual: str(live['log-setting']) || 'not set', severity: 'info' })
  }
  const liveDisabled = str(live.disabled).toLowerCase() === 'yes'
  if (liveDisabled !== spec.disabled) {
    diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(liveDisabled), severity: 'info' })
  }
  return diffs
}

/**
 * Validate authentication rules: a name and an authentication enforcement
 * object name are required, the name is unique across the canvas, and the
 * timeout is a positive number of minutes.
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
  for (const spec of extractAuthenticationRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Authentication rule name is required', code: 'required' })
    }
    if (!spec.authenticationEnforcement) {
      errors.push({ field: `${prefix}.authentication_enforcement`, message: 'An authentication enforcement object name is required', code: 'required' })
    }
    if (!Number.isFinite(spec.timeout) || spec.timeout <= 0) {
      errors.push({ field: `${prefix}.timeout`, message: 'Timeout must be a positive number of minutes', code: 'invalid_timeout' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate authentication rule "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
