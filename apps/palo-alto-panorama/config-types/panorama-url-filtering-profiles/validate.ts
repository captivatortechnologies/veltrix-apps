import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, memberList, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/URLFilteringSecurityProfiles'

/** The per-action category buckets; each canvas key equals its REST element name. */
export const URL_ACTIONS = ['block', 'alert', 'allow', 'continue', 'override'] as const
export type UrlAction = (typeof URL_ACTIONS)[number]

export interface UrlFilteringSpec {
  sectionName: string
  name: string
  description: string
  /** action element -> categories in that bucket. */
  buckets: Record<UrlAction, string[]>
  safeSearchEnforcement: boolean
  logContainerPageOnly: boolean
}

export interface LiveUrlFiltering extends PanoramaEntry {
  description?: string
  block?: { member?: string[] }
  alert?: { member?: string[] }
  allow?: { member?: string[] }
  continue?: { member?: string[] }
  override?: { member?: string[] }
  'safe-search-enforcement'?: string
  'log-container-page-only'?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractUrlFilteringSpecs(canvas: CanvasSnapshot): UrlFilteringSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const buckets = {} as Record<UrlAction, string[]>
    for (const action of URL_ACTIONS) buckets[action] = splitList(fields[action])
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      buckets,
      safeSearchEnforcement: coerceBoolean(fields.safe_search_enforcement, false),
      logContainerPageOnly: coerceBoolean(fields.log_container_page_only, true),
    }
  })
}

/** Build the REST entry fields for a URL filtering profile. */
export function buildUrlFilteringFields(spec: UrlFilteringSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const action of URL_ACTIONS) {
    const wrapped = memberList(spec.buckets[action])
    if (wrapped) fields[action] = wrapped
  }
  fields['safe-search-enforcement'] = spec.safeSearchEnforcement ? 'yes' : 'no'
  fields['log-container-page-only'] = spec.logContainerPageOnly ? 'yes' : 'no'
  if (spec.description) fields.description = spec.description
  return fields
}

export function urlFilteringUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractUrlFilteringSpecs(canvas)
    .filter((s) => s.name)
    .map((s) => ({ name: s.name, fields: buildUrlFilteringFields(s) }))
}

export function urlFilteringDriftDiffs(spec: UrlFilteringSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveUrlFiltering
  for (const action of URL_ACTIONS) {
    const expected = spec.buckets[action]
    const actual = Array.isArray(live[action]?.member) ? (live[action]!.member as string[]) : []
    if (!sameSet(actual, expected)) {
      diffs.push({ field: `${spec.name}.${action}`, expected: expected.join(', ') || 'none', actual: actual.join(', ') || 'none', severity: 'warning' })
    }
  }
  const liveSafe = str(live['safe-search-enforcement']).toLowerCase() === 'yes'
  if (liveSafe !== spec.safeSearchEnforcement) {
    diffs.push({ field: `${spec.name}.safe-search-enforcement`, expected: String(spec.safeSearchEnforcement), actual: String(liveSafe), severity: 'info' })
  }
  const liveLog = str(live['log-container-page-only']).toLowerCase() === 'yes'
  if (liveLog !== spec.logContainerPageOnly) {
    diffs.push({ field: `${spec.name}.log-container-page-only`, expected: String(spec.logContainerPageOnly), actual: String(liveLog), severity: 'info' })
  }
  return diffs
}

/**
 * Validate URL filtering profiles: a name is required and unique across the
 * canvas, no URL category appears in more than one action bucket, and a profile
 * with no bucketed categories at all is flagged as a warning.
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
  for (const spec of extractUrlFilteringSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'URL filtering profile name is required', code: 'required' })
    }

    const placement = new Map<string, UrlAction>()
    let bucketed = 0
    for (const action of URL_ACTIONS) {
      for (const category of spec.buckets[action]) {
        bucketed++
        const key = category.toLowerCase()
        const prior = placement.get(key)
        if (prior && prior !== action) {
          errors.push({
            field: `${prefix}.${action}`,
            message: `Category "${category}" is in both "${prior}" and "${action}" — a category may appear in only one action`,
            code: 'category_conflict',
          })
        }
        placement.set(key, action)
      }
    }
    if (bucketed === 0) {
      warnings.push({ field: `${prefix}.block`, message: 'This profile buckets no categories — every category keeps its firmware default', code: 'no_categories' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate URL filtering profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
