import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's gen/definitions/url_group.yaml `rest_endpoint`.
export const URL_GROUPS_PATH = '/object/urlgroups'

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface UrlGroupSpec {
  sectionName: string
  name: string
  urlObjectNames: string[]
  literalUrls: string[]
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

export function extractUrlGroupSpecs(canvas: CanvasSnapshot): UrlGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      urlObjectNames: splitList(fields.url_object_names),
      literalUrls: splitList(fields.literal_urls),
      description: str(fields.description),
      overridable: coerceBool(fields.overridable, false),
    }
  })
}

export function buildUrlGroupBaseFields(spec: UrlGroupSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { overridable: spec.overridable }
  if (spec.description) fields.description = spec.description
  if (spec.literalUrls.length > 0) fields.literals = spec.literalUrls.map((url) => ({ url }))
  return fields
}

/** Validate URL groups: a valid name and at least one member (object or literal) are required; names are unique. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractUrlGroupSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else if (!NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'FMC object names allow letters, numbers, periods, underscores and hyphens only - no spaces',
        code: 'invalid_name',
      })
    }

    if (spec.urlObjectNames.length === 0 && spec.literalUrls.length === 0) {
      errors.push({ field: `${prefix}.url_object_names`, message: 'At least one URL object or literal URL member is required', code: 'required' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate group "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
