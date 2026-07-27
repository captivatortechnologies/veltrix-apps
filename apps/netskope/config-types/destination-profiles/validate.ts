import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope destination (network-location) profile constraints -------------

export const MAX_NAME_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 200
export const DESTINATION_TYPES = ['regex', 'sensitive', 'insensitive'] as const
export type DestinationType = (typeof DESTINATION_TYPES)[number]

export interface DestinationProfileSpec {
  itemId?: string
  /** name — the logical identity (profiles are id-addressed; the app matches on
   *  name and stores the profile_id for rename-safety). */
  name: string
  type: string
  description: string
  values: string[]
  /** RBAC label NAMES; resolved to label_ids against the live labels at deploy. */
  labels: string[]
}

/** A destination profile as returned by GET /api/v2/profiles/destinations. */
export interface LiveDestinationProfile {
  profile_id?: string
  id?: string | number
  name?: string
  type?: string
  description?: string
  values?: string[]
  label_ids?: Array<string | number>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveDestinationProfileId(l: LiveDestinationProfile): string | undefined {
  const v = l.profile_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractDestinationProfileSpecs(canvas: CanvasSnapshot): DestinationProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type) || 'insensitive',
      description: asString(f.description),
      values: splitEntries(f.values),
      labels: splitEntries(f.labels),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDestinationProfileSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Profile name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate destination profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!DESTINATION_TYPES.includes(spec.type as DestinationType)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of ${DESTINATION_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.values.length === 0) {
      warnings.push({ field: `${prefix}.values`, message: 'No destination values — this profile will not match anything', code: 'no_values' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
