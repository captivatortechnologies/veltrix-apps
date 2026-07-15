import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA IP Source Groups constraints ----------------------------------------

/** ZIA caps an IP source group name and description at 255 characters. */
export const MAX_GROUP_NAME_LENGTH = 255
export const MAX_GROUP_DESCRIPTION_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IpSourceGroupSpec {
  sectionName: string
  /** The IP source group name — its logical identity (list + match). */
  name: string
  description?: string
  /** Source IPs: single IPs, CIDRs or ranges, one per authored line. */
  ipAddresses: string[]
}

/** Shape of an IP source group returned by GET /ipSourceGroups. */
export interface LiveIpSourceGroup {
  id?: number
  name?: string
  description?: string
  ipAddresses?: string[]
}

/** Split a textarea value into trimmed, non-blank lines. */
export function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZIA IP source group. */
export function extractIpSourceGroupSpecs(canvas: CanvasSnapshot): IpSourceGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      ipAddresses: splitLines(fields.ip_addresses),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate IP source group configurations against ZIA constraints: a name is
 * required and capped at 255 chars, the description is capped at 255 chars, at
 * least one IP address is required, and the name — a group's logical identity —
 * must be unique across the canvas (matched case-insensitively, since ZIA
 * rejects groups differing only in case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIpSourceGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'IP source group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `IP source group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate IP source group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_ip_source_group',
        })
      }
      seen.add(key)
    }

    if (spec.description && spec.description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_GROUP_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.ipAddresses.length === 0) {
      errors.push({
        field: `${prefix}.ip_addresses`,
        message: 'At least one IP address is required',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
