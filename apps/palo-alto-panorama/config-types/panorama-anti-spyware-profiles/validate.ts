import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/AntiSpywareSecurityProfiles'

/** Anti-spyware rule actions modeled here (empty-choice actions only). */
export const SPYWARE_ACTIONS = ['default', 'allow', 'alert', 'drop', 'reset-client', 'reset-server', 'reset-both'] as const
export type SpywareAction = (typeof SPYWARE_ACTIONS)[number]

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const
export type Severity = (typeof SEVERITIES)[number]

export const PACKET_CAPTURE_MODES = ['disable', 'single-packet', 'extended-capture'] as const
export type PacketCapture = (typeof PACKET_CAPTURE_MODES)[number]

const DEFAULT_RULE_NAME = 'block-critical-high-medium'
const DEFAULT_SEVERITIES = ['critical', 'high', 'medium']

export interface AntiSpywareSpec {
  sectionName: string
  name: string
  description: string
  ruleName: string
  severity: string[]
  action: string
  packetCapture: string
  category: string
  threatName: string
}

interface LiveSpywareRule {
  '@name'?: string
  action?: unknown
  severity?: { member?: string[] }
  category?: string
  'threat-name'?: string
  'packet-capture'?: string
}

export interface LiveAntiSpyware extends PanoramaEntry {
  description?: string
  rules?: { entry?: LiveSpywareRule | LiveSpywareRule[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read the action from a REST rule: a choice object ({ "reset-both": {} }) or a bare string. */
export function liveActionName(action: unknown): string {
  if (typeof action === 'string') return action.trim()
  if (action && typeof action === 'object') {
    const keys = Object.keys(action as Record<string, unknown>)
    return keys.length > 0 ? keys[0] : ''
  }
  return ''
}

export function extractAntiSpywareSpecs(canvas: CanvasSnapshot): AntiSpywareSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      ruleName: str(fields.rule_name) || DEFAULT_RULE_NAME,
      severity: splitList(fields.severity),
      action: str(fields.action) || 'reset-both',
      packetCapture: str(fields.packet_capture) || 'disable',
      category: str(fields.category) || 'any',
      threatName: str(fields.threat_name) || 'any',
    }
  })
}

/** The effective (defaulted) rule fields, shared by build + drift. */
export function effectiveRule(spec: AntiSpywareSpec) {
  return {
    severity: spec.severity.length > 0 ? spec.severity : DEFAULT_SEVERITIES,
    action: spec.action,
    packetCapture: spec.packetCapture,
    category: spec.category || 'any',
    threatName: spec.threatName || 'any',
  }
}

/** Build the REST entry fields for an anti-spyware profile (single rule). */
export function buildAntiSpywareFields(spec: AntiSpywareSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  const rule: Record<string, unknown> = {
    '@name': spec.ruleName,
    action: { [eff.action]: {} },
    severity: { member: eff.severity },
    category: eff.category,
    'threat-name': eff.threatName,
    'packet-capture': eff.packetCapture,
  }
  const fields: Record<string, unknown> = { rules: { entry: [rule] } }
  if (spec.description) fields.description = spec.description
  return fields
}

export function antiSpywareUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractAntiSpywareSpecs(canvas)
    .filter(
      (s) =>
        s.name &&
        SPYWARE_ACTIONS.includes(s.action as SpywareAction) &&
        PACKET_CAPTURE_MODES.includes(s.packetCapture as PacketCapture),
    )
    .map((s) => ({ name: s.name, fields: buildAntiSpywareFields(s) }))
}

function liveRules(entry: PanoramaEntry): LiveSpywareRule[] {
  const rules = (entry as LiveAntiSpyware).rules?.entry
  if (!rules) return []
  return Array.isArray(rules) ? rules : [rules]
}

export function antiSpywareDriftDiffs(spec: AntiSpywareSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const eff = effectiveRule(spec)
  const rule = liveRules(entry).find((r) => str(r['@name']).toLowerCase() === spec.ruleName.toLowerCase())
  if (!rule) {
    diffs.push({ field: `${spec.name}.${spec.ruleName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return diffs
  }
  const liveAction = liveActionName(rule.action)
  if (liveAction !== eff.action) {
    diffs.push({ field: `${spec.name}.action`, expected: eff.action, actual: liveAction || 'not set', severity: 'warning' })
  }
  const liveSeverity = Array.isArray(rule.severity?.member) ? (rule.severity!.member as string[]) : []
  if (!sameSet(liveSeverity, eff.severity)) {
    diffs.push({ field: `${spec.name}.severity`, expected: eff.severity.join(', '), actual: liveSeverity.join(', ') || 'none', severity: 'warning' })
  }
  if (str(rule['packet-capture']) !== eff.packetCapture) {
    diffs.push({ field: `${spec.name}.packet-capture`, expected: eff.packetCapture, actual: str(rule['packet-capture']) || 'not set', severity: 'info' })
  }
  if (str(rule.category) !== eff.category) {
    diffs.push({ field: `${spec.name}.category`, expected: eff.category, actual: str(rule.category) || 'not set', severity: 'info' })
  }
  if (str(rule['threat-name']) !== eff.threatName) {
    diffs.push({ field: `${spec.name}.threat-name`, expected: eff.threatName, actual: str(rule['threat-name']) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate anti-spyware profiles: a name and rule name are required and the name
 * is unique across the canvas; the action, packet-capture mode and every listed
 * severity are supported values.
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
  for (const spec of extractAntiSpywareSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Anti-spyware profile name is required', code: 'required' })
    }
    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    }
    if (!SPYWARE_ACTIONS.includes(spec.action as SpywareAction)) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!PACKET_CAPTURE_MODES.includes(spec.packetCapture as PacketCapture)) {
      errors.push({ field: `${prefix}.packet_capture`, message: `Unsupported packet-capture mode "${spec.packetCapture}"`, code: 'invalid_packet_capture' })
    }
    for (const sev of spec.severity) {
      if (!SEVERITIES.includes(sev as Severity)) {
        errors.push({ field: `${prefix}.severity`, message: `Unsupported severity "${sev}" — use critical, high, medium, low or informational`, code: 'invalid_severity' })
      }
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate anti-spyware profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
