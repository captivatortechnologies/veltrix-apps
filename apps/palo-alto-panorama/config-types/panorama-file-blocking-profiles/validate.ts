import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// File Blocking profiles (/Objects/FileBlockingSecurityProfiles) — referenced
// from panorama-security-profile-groups ("file_blocking"). Cited: PAN-OS REST
// API "Objects" category, class FileBlockingSecurityProfiles in pypanrestv2
// (github.com/mrzepa/pypanrestv2, Objects.py) and terraform-provider-panos
// panos_file_blocking_security_profile (rules[].{applications,file_types,
// direction,action} — action is a plain string, unlike the AV/spyware/
// vulnerability profiles' choice-style action).
export const RESOURCE_PATH = '/Objects/FileBlockingSecurityProfiles'

export const FILE_BLOCKING_ACTIONS = ['alert', 'block', 'continue'] as const
export type FileBlockingAction = (typeof FILE_BLOCKING_ACTIONS)[number]

export const DIRECTIONS = ['both', 'upload', 'download'] as const
export type Direction = (typeof DIRECTIONS)[number]

const DEFAULT_RULE_NAME = 'block-executables'

export interface FileBlockingSpec {
  sectionName: string
  name: string
  description: string
  ruleName: string
  applications: string[]
  fileTypes: string[]
  direction: string
  action: string
}

interface LiveFileBlockingRule {
  '@name'?: string
  applications?: { member?: string[] }
  'file-types'?: { member?: string[] }
  direction?: string
  action?: string
}

export interface LiveFileBlocking extends PanoramaEntry {
  description?: string
  rules?: { entry?: LiveFileBlockingRule | LiveFileBlockingRule[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

export function extractFileBlockingSpecs(canvas: CanvasSnapshot): FileBlockingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      ruleName: str(fields.rule_name) || DEFAULT_RULE_NAME,
      applications: splitList(fields.applications),
      fileTypes: splitList(fields.file_types),
      direction: str(fields.direction) || 'both',
      action: str(fields.action) || 'block',
    }
  })
}

/** The effective (defaulted) rule match fields, shared by build + drift. */
export function effectiveRule(spec: FileBlockingSpec) {
  return {
    applications: orDefault(spec.applications, ['any']),
    fileTypes: orDefault(spec.fileTypes, ['any']),
    direction: spec.direction,
    action: spec.action,
  }
}

/** Build the REST entry fields for a file blocking profile (single rule). */
export function buildFileBlockingFields(spec: FileBlockingSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  const rule: Record<string, unknown> = {
    '@name': spec.ruleName,
    applications: { member: eff.applications },
    'file-types': { member: eff.fileTypes },
    direction: eff.direction,
    action: eff.action,
  }
  const fields: Record<string, unknown> = { rules: { entry: [rule] } }
  if (spec.description) fields.description = spec.description
  return fields
}

export function fileBlockingUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractFileBlockingSpecs(canvas)
    .filter(
      (s) =>
        s.name &&
        FILE_BLOCKING_ACTIONS.includes(s.action as FileBlockingAction) &&
        DIRECTIONS.includes(s.direction as Direction),
    )
    .map((s) => ({ name: s.name, fields: buildFileBlockingFields(s) }))
}

function liveRules(entry: PanoramaEntry): LiveFileBlockingRule[] {
  const rules = (entry as LiveFileBlocking).rules?.entry
  if (!rules) return []
  return Array.isArray(rules) ? rules : [rules]
}

export function fileBlockingDriftDiffs(spec: FileBlockingSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const eff = effectiveRule(spec)
  const rule = liveRules(entry).find((r) => str(r['@name']).toLowerCase() === spec.ruleName.toLowerCase())
  if (!rule) {
    diffs.push({ field: `${spec.name}.${spec.ruleName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return diffs
  }
  const liveApps = Array.isArray(rule.applications?.member) ? (rule.applications!.member as string[]) : []
  if (!sameSet(liveApps, eff.applications)) {
    diffs.push({ field: `${spec.name}.applications`, expected: eff.applications.join(', '), actual: liveApps.join(', ') || 'none', severity: 'warning' })
  }
  const liveFileTypes = Array.isArray(rule['file-types']?.member) ? (rule['file-types']!.member as string[]) : []
  if (!sameSet(liveFileTypes, eff.fileTypes)) {
    diffs.push({ field: `${spec.name}.file-types`, expected: eff.fileTypes.join(', '), actual: liveFileTypes.join(', ') || 'none', severity: 'warning' })
  }
  if (str(rule.direction) !== eff.direction) {
    diffs.push({ field: `${spec.name}.direction`, expected: eff.direction, actual: str(rule.direction) || 'not set', severity: 'warning' })
  }
  if (str(rule.action) !== eff.action) {
    diffs.push({ field: `${spec.name}.action`, expected: eff.action, actual: str(rule.action) || 'not set', severity: 'warning' })
  }
  return diffs
}

/**
 * Validate file blocking profiles: a name and rule name are required and the
 * name is unique across the canvas; the action and direction are supported
 * values.
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
  for (const spec of extractFileBlockingSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'File blocking profile name is required', code: 'required' })
    }
    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    }
    if (!FILE_BLOCKING_ACTIONS.includes(spec.action as FileBlockingAction)) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}" — use alert, block or continue`, code: 'invalid_action' })
    }
    if (!DIRECTIONS.includes(spec.direction as Direction)) {
      errors.push({ field: `${prefix}.direction`, message: `Unsupported direction "${spec.direction}" — use both, upload or download`, code: 'invalid_direction' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate file blocking profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
