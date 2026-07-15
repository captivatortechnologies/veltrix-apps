import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA IP Destination Group constraints ------------------------------------

/** ZIA caps an IP destination group name at 255 characters. */
export const MAX_GROUP_NAME_LENGTH = 255
export const MAX_GROUP_DESCRIPTION_LENGTH = 10240

/** The destination categories ZIA accepts for an IP destination group. */
export const DESTINATION_GROUP_TYPES = ['DSTN_IP', 'DSTN_FQDN', 'DSTN_DOMAIN', 'DSTN_OTHER'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DestinationGroupSpec {
  sectionName: string
  /** The destination group name — its logical identity (list + match). */
  name: string
  description?: string
  /** One of DESTINATION_GROUP_TYPES (empty string when not set). */
  type: string
  /** Destination entries (IPs/CIDRs, FQDNs or domains), one per line. */
  addresses: string[]
  /** Optional ISO country codes (used by DSTN_OTHER groups). */
  countries?: string[]
}

/** Shape of an IP destination group returned by GET /ipDestinationGroups. */
export interface LiveDestinationGroup {
  id?: number
  name?: string
  description?: string
  type?: string
  addresses?: string[]
  countries?: string[]
}

/** Split a textarea value into trimmed, non-blank lines. */
function toLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZIA IP destination group. */
export function extractDestinationGroupSpecs(canvas: CanvasSnapshot): DestinationGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const countries = toLines(fields.countries)
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      addresses: toLines(fields.addresses),
      countries: countries.length > 0 ? countries : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate IP destination group configurations against ZIA constraints: a name
 * is required, capped at 255 chars, and unique across the canvas (matched
 * case-insensitively, since ZIA rejects groups differing only in case); a
 * destination type is required and must be one of the accepted categories; and
 * at least one address is required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDestinationGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Destination group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Destination group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate destination group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_ip_destination_group',
        })
      }
      seen.add(key)
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Destination type is required', code: 'required' })
    } else if (!DESTINATION_GROUP_TYPES.includes(spec.type as (typeof DESTINATION_GROUP_TYPES)[number])) {
      errors.push({
        field: `${prefix}.type`,
        message: `Destination type must be one of: ${DESTINATION_GROUP_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    if (spec.addresses.length === 0) {
      errors.push({
        field: `${prefix}.addresses`,
        message: 'At least one destination address is required',
        code: 'required',
      })
    }

    if (spec.description && spec.description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_GROUP_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
