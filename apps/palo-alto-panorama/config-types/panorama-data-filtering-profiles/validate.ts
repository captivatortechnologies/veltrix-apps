import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Data Filtering profiles (/Objects/DataFilteringSecurityProfiles) — referenced
// from panorama-security-profile-groups ("data_filtering"). Cited: PAN-OS REST
// API "Objects" category, class DataFilteringSecurityProfiles in pypanrestv2
// (github.com/mrzepa/pypanrestv2, Objects.py) and terraform-provider-panos
// panos_data_filtering_profile (data_capture, rules[].{data_object,direction,
// application,file_type,alert_threshold,block_threshold,log_severity}).
//
// `data_object` references a Custom Data Pattern object (/Objects/
// CustomDataPatterns) by name — that object type is NOT authored by this app
// (same free-text-reference precedent as security-rules' profile_group /
// log_setting), so it must already exist in Panorama.
export const RESOURCE_PATH = '/Objects/DataFilteringSecurityProfiles'

export const DIRECTIONS = ['both', 'upload', 'download'] as const
export type Direction = (typeof DIRECTIONS)[number]

export const LOG_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const
export type LogSeverity = (typeof LOG_SEVERITIES)[number]

const DEFAULT_RULE_NAME = 'default'
const DEFAULT_ALERT_THRESHOLD = 10
const DEFAULT_BLOCK_THRESHOLD = 20

export interface DataFilteringSpec {
  sectionName: string
  name: string
  description: string
  dataCapture: boolean
  ruleName: string
  dataObject: string
  direction: string
  application: string[]
  fileType: string[]
  alertThreshold: number
  blockThreshold: number
  logSeverity: string
}

interface LiveDataFilteringRule {
  '@name'?: string
  'data-object'?: string
  direction?: string
  application?: { member?: string[] }
  'file-type'?: { member?: string[] }
  'alert-threshold'?: number | string
  'block-threshold'?: number | string
  'log-severity'?: string
}

export interface LiveDataFiltering extends PanoramaEntry {
  description?: string
  'data-capture'?: string
  rules?: { entry?: LiveDataFilteringRule | LiveDataFilteringRule[] }
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

export function extractDataFilteringSpecs(canvas: CanvasSnapshot): DataFilteringSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      dataCapture: coerceBoolean(fields.data_capture, false),
      ruleName: str(fields.rule_name) || DEFAULT_RULE_NAME,
      dataObject: str(fields.data_object),
      direction: str(fields.direction) || 'both',
      application: splitList(fields.application),
      fileType: splitList(fields.file_type),
      alertThreshold: num(fields.alert_threshold, DEFAULT_ALERT_THRESHOLD),
      blockThreshold: num(fields.block_threshold, DEFAULT_BLOCK_THRESHOLD),
      logSeverity: str(fields.log_severity) || 'medium',
    }
  })
}

/** The effective (defaulted) rule match fields, shared by build + drift. */
export function effectiveRule(spec: DataFilteringSpec) {
  return {
    application: orDefault(spec.application, ['any']),
    fileType: orDefault(spec.fileType, ['any']),
    direction: spec.direction,
  }
}

/** Build the REST entry fields for a data filtering profile (single rule). */
export function buildDataFilteringFields(spec: DataFilteringSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  const rule: Record<string, unknown> = {
    '@name': spec.ruleName,
    'data-object': spec.dataObject,
    direction: eff.direction,
    application: { member: eff.application },
    'file-type': { member: eff.fileType },
    'alert-threshold': spec.alertThreshold,
    'block-threshold': spec.blockThreshold,
    'log-severity': spec.logSeverity,
  }
  const fields: Record<string, unknown> = { rules: { entry: [rule] }, 'data-capture': spec.dataCapture ? 'yes' : 'no' }
  if (spec.description) fields.description = spec.description
  return fields
}

export function dataFilteringUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractDataFilteringSpecs(canvas)
    .filter(
      (s) =>
        s.name &&
        s.dataObject &&
        DIRECTIONS.includes(s.direction as Direction) &&
        LOG_SEVERITIES.includes(s.logSeverity as LogSeverity),
    )
    .map((s) => ({ name: s.name, fields: buildDataFilteringFields(s) }))
}

function liveRules(entry: PanoramaEntry): LiveDataFilteringRule[] {
  const rules = (entry as LiveDataFiltering).rules?.entry
  if (!rules) return []
  return Array.isArray(rules) ? rules : [rules]
}

export function dataFilteringDriftDiffs(spec: DataFilteringSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveDataFiltering
  const eff = effectiveRule(spec)

  const liveCapture = str(live['data-capture']).toLowerCase() === 'yes'
  if (liveCapture !== spec.dataCapture) {
    diffs.push({ field: `${spec.name}.data-capture`, expected: String(spec.dataCapture), actual: String(liveCapture), severity: 'info' })
  }

  const rule = liveRules(entry).find((r) => str(r['@name']).toLowerCase() === spec.ruleName.toLowerCase())
  if (!rule) {
    diffs.push({ field: `${spec.name}.${spec.ruleName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return diffs
  }
  if (str(rule['data-object']) !== spec.dataObject) {
    diffs.push({ field: `${spec.name}.data-object`, expected: spec.dataObject, actual: str(rule['data-object']) || 'not set', severity: 'critical' })
  }
  if (str(rule.direction) !== eff.direction) {
    diffs.push({ field: `${spec.name}.direction`, expected: eff.direction, actual: str(rule.direction) || 'not set', severity: 'warning' })
  }
  const liveApps = Array.isArray(rule.application?.member) ? (rule.application!.member as string[]) : []
  if (!sameSet(liveApps, eff.application)) {
    diffs.push({ field: `${spec.name}.application`, expected: eff.application.join(', '), actual: liveApps.join(', ') || 'none', severity: 'warning' })
  }
  const liveFileTypes = Array.isArray(rule['file-type']?.member) ? (rule['file-type']!.member as string[]) : []
  if (!sameSet(liveFileTypes, eff.fileType)) {
    diffs.push({ field: `${spec.name}.file-type`, expected: eff.fileType.join(', '), actual: liveFileTypes.join(', ') || 'none', severity: 'warning' })
  }
  if (num(rule['alert-threshold'], -1) !== spec.alertThreshold) {
    diffs.push({ field: `${spec.name}.alert-threshold`, expected: String(spec.alertThreshold), actual: String(rule['alert-threshold'] ?? 'not set'), severity: 'info' })
  }
  if (num(rule['block-threshold'], -1) !== spec.blockThreshold) {
    diffs.push({ field: `${spec.name}.block-threshold`, expected: String(spec.blockThreshold), actual: String(rule['block-threshold'] ?? 'not set'), severity: 'info' })
  }
  if (str(rule['log-severity']) !== spec.logSeverity) {
    diffs.push({ field: `${spec.name}.log-severity`, expected: spec.logSeverity, actual: str(rule['log-severity']) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate data filtering profiles: a name, rule name and referenced data
 * object are required and the name is unique across the canvas; direction and
 * log severity are supported values.
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
  for (const spec of extractDataFilteringSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Data filtering profile name is required', code: 'required' })
    }
    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    }
    if (!spec.dataObject) {
      errors.push({ field: `${prefix}.data_object`, message: 'A data pattern object name is required — the rule matches nothing without one', code: 'required' })
    }
    if (!DIRECTIONS.includes(spec.direction as Direction)) {
      errors.push({ field: `${prefix}.direction`, message: `Unsupported direction "${spec.direction}" — use both, upload or download`, code: 'invalid_direction' })
    }
    if (!LOG_SEVERITIES.includes(spec.logSeverity as LogSeverity)) {
      errors.push({ field: `${prefix}.log_severity`, message: `Unsupported log severity "${spec.logSeverity}"`, code: 'invalid_severity' })
    }
    if (spec.blockThreshold < spec.alertThreshold) {
      warnings.push({ field: `${prefix}.block_threshold`, message: 'Block threshold is lower than alert threshold — traffic will be blocked before it is even alerted on', code: 'threshold_order' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate data filtering profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
