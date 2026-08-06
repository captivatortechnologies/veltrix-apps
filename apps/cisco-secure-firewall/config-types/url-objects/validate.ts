import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { FmcObject, UpsertSpec } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's gen/definitions/url.yaml `rest_endpoint`.
export const URL_OBJECTS_PATH = '/object/urls'

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface UrlObjectSpec {
  sectionName: string
  name: string
  url: string
  description: string
  overridable: boolean
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function coerceBool(value: unknown, def: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return def
}

export function extractUrlObjectSpecs(canvas: CanvasSnapshot): UrlObjectSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      url: str(fields.url),
      description: str(fields.description),
      overridable: coerceBool(fields.overridable, false),
    }
  })
}

export function buildUrlObjectFields(spec: UrlObjectSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { url: spec.url, overridable: spec.overridable }
  if (spec.description) fields.description = spec.description
  return fields
}

export function urlObjectUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractUrlObjectSpecs(canvas)
    .filter((s) => s.name && s.url)
    .map((s) => ({ name: s.name, fields: buildUrlObjectFields(s) }))
}

export function urlObjectDriftDiffs(spec: UrlObjectSpec, live: FmcObject): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const liveUrl = typeof live.url === 'string' ? live.url : ''
  if (liveUrl !== spec.url) {
    diffs.push({ field: `${spec.name}.url`, expected: spec.url, actual: liveUrl || 'not set', severity: 'warning' })
  }
  return diffs
}

/** Validate URL objects: a valid name and a URL are required; names are unique. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractUrlObjectSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Object name is required', code: 'required' })
    } else if (!NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'FMC object names allow letters, numbers, periods, underscores and hyphens only - no spaces',
        code: 'invalid_name',
      })
    }

    if (!spec.url) {
      errors.push({ field: `${prefix}.url`, message: 'URL is required', code: 'required' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate object "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
