import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Decryption rules (/Policies/DecryptionPreRules) — the device-group PRE
// rulebase decides which traffic gets SSL forward-proxy decryption, SSL
// inbound inspection, or SSH proxy. Cited: PAN-OS REST API "Policies" category;
// class DecryptionRules in pypanrestv2 (github.com/mrzepa/pypanrestv2,
// Policies.py) resolves to REST path "<class>".split('Rules')[0] + rulebase +
// "Rules" (the same convention this app's panorama-security-rules /
// panorama-nat-rules already use, verified against their own working
// SecurityPreRules / NATPreRules paths) => DecryptionPreRules; and
// terraform-provider-panos panos_decryption_policy_rules (rules[].{source_
// zones,source_addresses,destination_zones,destination_addresses,category,
// services,type,action,profile,log_setting,log_success,log_fail}).
export const RESOURCE_PATH = '/Policies/DecryptionPreRules'

export const DECRYPTION_TYPES = ['ssl-forward-proxy', 'ssl-inbound-inspection', 'ssh-proxy'] as const
export type DecryptionType = (typeof DECRYPTION_TYPES)[number]

export const DECRYPTION_ACTIONS = ['no-decrypt', 'decrypt'] as const
export type DecryptionAction = (typeof DECRYPTION_ACTIONS)[number]

export interface DecryptionRuleSpec {
  sectionName: string
  name: string
  fromZones: string[]
  toZones: string[]
  source: string[]
  destination: string[]
  category: string[]
  service: string[]
  type: string
  certificates: string[]
  profile: string
  action: string
  logSetting: string
  logSuccess: boolean
  logFail: boolean
  disabled: boolean
  description: string
}

interface LiveDecryptionType {
  'ssl-forward-proxy'?: Record<string, never>
  'ssl-inbound-inspection'?: { certificates?: { member?: string[] } }
  'ssh-proxy'?: Record<string, never>
}

export interface LiveDecryptionRule extends PanoramaEntry {
  from?: { member?: string[] }
  to?: { member?: string[] }
  source?: { member?: string[] }
  destination?: { member?: string[] }
  category?: { member?: string[] }
  service?: { member?: string[] }
  type?: LiveDecryptionType
  profile?: string
  action?: string
  'log-setting'?: string
  'log-success'?: string
  'log-fail'?: string
  disabled?: string
  description?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

export function extractDecryptionRuleSpecs(canvas: CanvasSnapshot): DecryptionRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      fromZones: splitList(fields.from_zones),
      toZones: splitList(fields.to_zones),
      source: splitList(fields.source),
      destination: splitList(fields.destination),
      category: splitList(fields.category),
      service: splitList(fields.service),
      type: str(fields.type) || 'ssl-forward-proxy',
      certificates: splitList(fields.certificates),
      profile: str(fields.profile),
      action: str(fields.action) || 'no-decrypt',
      logSetting: str(fields.log_setting),
      logSuccess: coerceBoolean(fields.log_success, false),
      logFail: coerceBoolean(fields.log_fail, true),
      disabled: coerceBoolean(fields.disabled, false),
      description: str(fields.description),
    }
  })
}

/** The effective (defaulted) match fields, shared by build + drift. */
export function effectiveRule(spec: DecryptionRuleSpec) {
  return {
    from: orDefault(spec.fromZones, ['any']),
    to: orDefault(spec.toZones, ['any']),
    source: orDefault(spec.source, ['any']),
    destination: orDefault(spec.destination, ['any']),
    category: orDefault(spec.category, ['any']),
    service: orDefault(spec.service, ['any']),
  }
}

/** Build the REST `type` choice element — only ssl-inbound-inspection carries data. */
export function buildDecryptionType(spec: DecryptionRuleSpec): Record<string, unknown> {
  if (spec.type === 'ssl-inbound-inspection') {
    return { 'ssl-inbound-inspection': { certificates: { member: spec.certificates } } }
  }
  return { [spec.type]: {} }
}

/** Build the REST entry fields for a decryption pre-rule. */
export function buildDecryptionRuleFields(spec: DecryptionRuleSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  const fields: Record<string, unknown> = {
    from: { member: eff.from },
    to: { member: eff.to },
    source: { member: eff.source },
    destination: { member: eff.destination },
    category: { member: eff.category },
    service: { member: eff.service },
    type: buildDecryptionType(spec),
    action: spec.action,
    'log-success': spec.logSuccess ? 'yes' : 'no',
    'log-fail': spec.logFail ? 'yes' : 'no',
    disabled: spec.disabled ? 'yes' : 'no',
  }
  if (spec.profile) fields.profile = spec.profile
  if (spec.logSetting) fields['log-setting'] = spec.logSetting
  if (spec.description) fields.description = spec.description
  return fields
}

export function decryptionRuleUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractDecryptionRuleSpecs(canvas)
    .filter((s) => s.name && DECRYPTION_TYPES.includes(s.type as DecryptionType) && DECRYPTION_ACTIONS.includes(s.action as DecryptionAction))
    .map((s) => ({ name: s.name, fields: buildDecryptionRuleFields(s) }))
}

function liveTypeName(type: LiveDecryptionType | undefined): string {
  if (!type) return ''
  const keys = Object.keys(type)
  return keys.length > 0 ? keys[0] : ''
}

export function decryptionRuleDriftDiffs(spec: DecryptionRuleSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveDecryptionRule
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
  compareSet('category', eff.category, live.category?.member)
  compareSet('service', eff.service, live.service?.member)

  const liveTypeKey = liveTypeName(live.type)
  if (liveTypeKey !== spec.type) {
    diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveTypeKey || 'not set', severity: 'warning' })
  } else if (spec.type === 'ssl-inbound-inspection') {
    const liveCerts = Array.isArray(live.type?.['ssl-inbound-inspection']?.certificates?.member)
      ? (live.type!['ssl-inbound-inspection']!.certificates!.member as string[])
      : []
    if (!sameSet(liveCerts, spec.certificates)) {
      diffs.push({ field: `${spec.name}.certificates`, expected: spec.certificates.join(', ') || 'none', actual: liveCerts.join(', ') || 'none', severity: 'warning' })
    }
  }

  if (str(live.action) !== spec.action) {
    diffs.push({ field: `${spec.name}.action`, expected: spec.action, actual: str(live.action) || 'not set', severity: 'critical' })
  }
  if (spec.profile && str(live.profile) !== spec.profile) {
    diffs.push({ field: `${spec.name}.profile`, expected: spec.profile, actual: str(live.profile) || 'not set', severity: 'info' })
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
 * Validate decryption rules: a name is required and unique across the canvas;
 * type and action are supported values; and ssl-inbound-inspection needs at
 * least one certificate to inspect.
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
  for (const spec of extractDecryptionRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Decryption rule name is required', code: 'required' })
    }
    if (!DECRYPTION_TYPES.includes(spec.type as DecryptionType)) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported type "${spec.type}"`, code: 'invalid_type' })
    } else if (spec.type === 'ssl-inbound-inspection' && spec.certificates.length === 0) {
      errors.push({ field: `${prefix}.certificates`, message: 'SSL Inbound Inspection needs at least one certificate', code: 'required' })
    }
    if (!DECRYPTION_ACTIONS.includes(spec.action as DecryptionAction)) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}" — use no-decrypt or decrypt`, code: 'invalid_action' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate decryption rule "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
