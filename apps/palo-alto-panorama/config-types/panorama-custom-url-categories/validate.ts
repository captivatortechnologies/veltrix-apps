import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Custom URL categories (/Objects/CustomURLCategories) are referenced from
// security rules ("category" match), decryption rules and URL Filtering
// profile action buckets. Cited: PAN-OS REST API "Objects" category, class
// CustomURLCategories in pypanrestv2 (github.com/mrzepa/pypanrestv2,
// Objects.py), and terraform-provider-panos panos_custom_url_category
// (type: "URL List" | "Category Match", list: [string]).
export const RESOURCE_PATH = '/Objects/CustomURLCategories'

export const CATEGORY_TYPES = ['URL List', 'Category Match'] as const
export type CategoryType = (typeof CATEGORY_TYPES)[number]

export interface CustomUrlCategorySpec {
  sectionName: string
  name: string
  description: string
  type: string
  list: string[]
}

export interface LiveCustomUrlCategory extends PanoramaEntry {
  description?: string
  type?: string
  list?: { member?: string[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractCustomUrlCategorySpecs(canvas: CanvasSnapshot): CustomUrlCategorySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      type: str(fields.type) || 'URL List',
      list: splitList(fields.list),
    }
  })
}

export function buildCustomUrlCategoryFields(spec: CustomUrlCategorySpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { type: spec.type, list: { member: spec.list } }
  if (spec.description) fields.description = spec.description
  return fields
}

export function customUrlCategoryUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractCustomUrlCategorySpecs(canvas)
    .filter((s) => s.name && CATEGORY_TYPES.includes(s.type as CategoryType))
    .map((s) => ({ name: s.name, fields: buildCustomUrlCategoryFields(s) }))
}

export function customUrlCategoryDriftDiffs(spec: CustomUrlCategorySpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveCustomUrlCategory
  if (str(live.type) !== spec.type) {
    diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: str(live.type) || 'not set', severity: 'warning' })
  }
  const liveList = Array.isArray(live.list?.member) ? (live.list!.member as string[]) : []
  if (!sameSet(liveList, spec.list)) {
    diffs.push({ field: `${spec.name}.list`, expected: spec.list.join(', ') || 'none', actual: liveList.join(', ') || 'none', severity: 'warning' })
  }
  if (spec.description && str(live.description) !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: str(live.description) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate custom URL categories: a name is required and unique across the
 * canvas, the type is one of the two PAN-OS values, and an empty list is
 * flagged as a warning (it would match nothing).
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
  for (const spec of extractCustomUrlCategorySpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Custom URL category name is required', code: 'required' })
    }
    if (!CATEGORY_TYPES.includes(spec.type as CategoryType)) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported type "${spec.type}" — use "URL List" or "Category Match"`, code: 'invalid_type' })
    }
    if (spec.list.length === 0) {
      warnings.push({ field: `${prefix}.list`, message: 'This category has an empty list — it will match nothing', code: 'empty_list' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate custom URL category "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
