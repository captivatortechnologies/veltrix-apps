import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { PanoramaEntry, UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/Tags'

/** PAN-OS tag palette (classic color1..color16 names). */
export const TAG_COLORS = [
  'color1', 'color2', 'color3', 'color4', 'color5', 'color6', 'color7', 'color8',
  'color9', 'color10', 'color11', 'color12', 'color13', 'color14', 'color15', 'color16',
] as const

export interface TagSpec {
  sectionName: string
  name: string
  color: string
  comments: string
}

/** Shape of a tag returned by GET /Objects/Tags. */
export interface LiveTag extends PanoramaEntry {
  color?: string
  comments?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Each canvas item describes one Panorama tag. */
export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      color: str(fields.color),
      comments: str(fields.comments),
    }
  })
}

/** Build the REST entry fields for a tag (identity is added by the client). */
export function buildTagFields(spec: TagSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (spec.color) fields.color = spec.color
  if (spec.comments) fields.comments = spec.comments
  return fields
}

/** UpsertSpec list for deploy. */
export function tagUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractTagSpecs(canvas)
    .filter((s) => s.name)
    .map((s) => ({ name: s.name, fields: buildTagFields(s) }))
}

/** Managed-field drift for one tag against its live entry. */
export function tagDriftDiffs(spec: TagSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveTag
  if (spec.color && str(live.color) !== spec.color) {
    diffs.push({ field: `${spec.name}.color`, expected: spec.color, actual: str(live.color) || 'not set', severity: 'info' })
  }
  if (spec.comments && str(live.comments) !== spec.comments) {
    diffs.push({ field: `${spec.name}.comments`, expected: spec.comments, actual: str(live.comments) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate tag configurations: a name is required, the color (when set) is a
 * supported palette value, and the tag name is unique across the canvas.
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
  for (const spec of extractTagSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Tag name is required', code: 'required' })
    }
    if (spec.color && !TAG_COLORS.includes(spec.color as (typeof TAG_COLORS)[number])) {
      errors.push({
        field: `${prefix}.color`,
        message: `Unsupported color "${spec.color}" — use color1..color16`,
        code: 'invalid_color',
      })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate tag "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
