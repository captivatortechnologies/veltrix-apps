import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/WildFireAnalysisSecurityProfiles'

export const DIRECTIONS = ['both', 'upload', 'download'] as const
export type Direction = (typeof DIRECTIONS)[number]

export const ANALYSIS_LOCATIONS = ['public-cloud', 'private-cloud'] as const
export type AnalysisLocation = (typeof ANALYSIS_LOCATIONS)[number]

const DEFAULT_RULE_NAME = 'forward-all'

export interface WildfireAnalysisSpec {
  sectionName: string
  name: string
  ruleName: string
  application: string[]
  fileType: string[]
  direction: string
  analysis: string
}

interface LiveWildfireRule {
  '@name'?: string
  application?: { member?: string[] }
  'file-type'?: { member?: string[] }
  direction?: string
  analysis?: string
}

export interface LiveWildfireAnalysis extends PanoramaEntry {
  rules?: { entry?: LiveWildfireRule | LiveWildfireRule[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function orDefault(list: string[], fallback: string[]): string[] {
  return list.length > 0 ? list : fallback
}

export function extractWildfireAnalysisSpecs(canvas: CanvasSnapshot): WildfireAnalysisSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      ruleName: str(fields.rule_name) || DEFAULT_RULE_NAME,
      application: splitList(fields.application),
      fileType: splitList(fields.file_type),
      direction: str(fields.direction) || 'both',
      analysis: str(fields.analysis) || 'public-cloud',
    }
  })
}

/** The effective (defaulted) rule match fields, shared by build + drift. */
export function effectiveRule(spec: WildfireAnalysisSpec) {
  return {
    application: orDefault(spec.application, ['any']),
    fileType: orDefault(spec.fileType, ['any']),
    direction: spec.direction,
    analysis: spec.analysis,
  }
}

/** Build the REST entry fields for a WildFire analysis profile (single rule). */
export function buildWildfireAnalysisFields(spec: WildfireAnalysisSpec): Record<string, unknown> {
  const eff = effectiveRule(spec)
  return {
    rules: {
      entry: [
        {
          '@name': spec.ruleName,
          application: { member: eff.application },
          'file-type': { member: eff.fileType },
          direction: eff.direction,
          analysis: eff.analysis,
        },
      ],
    },
  }
}

export function wildfireAnalysisUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractWildfireAnalysisSpecs(canvas)
    .filter((s) => s.name && DIRECTIONS.includes(s.direction as Direction) && ANALYSIS_LOCATIONS.includes(s.analysis as AnalysisLocation))
    .map((s) => ({ name: s.name, fields: buildWildfireAnalysisFields(s) }))
}

function liveRules(entry: PanoramaEntry): LiveWildfireRule[] {
  const rules = (entry as LiveWildfireAnalysis).rules?.entry
  if (!rules) return []
  return Array.isArray(rules) ? rules : [rules]
}

export function wildfireAnalysisDriftDiffs(spec: WildfireAnalysisSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const eff = effectiveRule(spec)
  const rule = liveRules(entry).find((r) => str(r['@name']).toLowerCase() === spec.ruleName.toLowerCase())
  if (!rule) {
    diffs.push({ field: `${spec.name}.${spec.ruleName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return diffs
  }
  const liveApp = Array.isArray(rule.application?.member) ? (rule.application!.member as string[]) : []
  if (!sameSet(liveApp, eff.application)) {
    diffs.push({ field: `${spec.name}.application`, expected: eff.application.join(', '), actual: liveApp.join(', ') || 'none', severity: 'warning' })
  }
  const liveFileType = Array.isArray(rule['file-type']?.member) ? (rule['file-type']!.member as string[]) : []
  if (!sameSet(liveFileType, eff.fileType)) {
    diffs.push({ field: `${spec.name}.file-type`, expected: eff.fileType.join(', '), actual: liveFileType.join(', ') || 'none', severity: 'warning' })
  }
  if (str(rule.direction) !== eff.direction) {
    diffs.push({ field: `${spec.name}.direction`, expected: eff.direction, actual: str(rule.direction) || 'not set', severity: 'warning' })
  }
  if (str(rule.analysis) !== eff.analysis) {
    diffs.push({ field: `${spec.name}.analysis`, expected: eff.analysis, actual: str(rule.analysis) || 'not set', severity: 'warning' })
  }
  return diffs
}

/**
 * Validate WildFire analysis profiles: a name and rule name are required, the
 * direction and analysis location are supported values, and the profile name is
 * unique across the canvas.
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
  for (const spec of extractWildfireAnalysisSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'WildFire analysis profile name is required', code: 'required' })
    }
    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    }
    if (!DIRECTIONS.includes(spec.direction as Direction)) {
      errors.push({ field: `${prefix}.direction`, message: `Unsupported direction "${spec.direction}" — use both, upload or download`, code: 'invalid_direction' })
    }
    if (!ANALYSIS_LOCATIONS.includes(spec.analysis as AnalysisLocation)) {
      errors.push({ field: `${prefix}.analysis`, message: `Unsupported analysis location "${spec.analysis}" — use public-cloud or private-cloud`, code: 'invalid_analysis' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate WildFire analysis profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
