import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra administrative-unit constraints -----------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_DESCRIPTION_LENGTH = 1024
/** visibility: public (the default, stored as null by Graph) or HiddenMembership. */
export const VISIBILITY_VALUES = ['public', 'hiddenmembership'] as const

export interface AdministrativeUnitSpec {
  itemId?: string
  /** displayName — the logical identity live administrative units are matched on. */
  name: string
  description: string
  /** 'public' | 'hiddenmembership'. */
  visibility: string
}

/** An administrative unit as returned by Graph GET /directory/administrativeUnits. */
export interface LiveAdministrativeUnit {
  id?: string
  displayName?: string
  description?: string | null
  visibility?: string | null
  membershipType?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** The Graph visibility value for a spec: 'HiddenMembership', or null for public. */
export function graphVisibility(spec: AdministrativeUnitSpec): string | null {
  return spec.visibility === 'hiddenmembership' ? 'HiddenMembership' : null
}

export function extractAdministrativeUnitSpecs(canvas: CanvasSnapshot): AdministrativeUnitSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      visibility: (asString(f.visibility) || 'public').toLowerCase(),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAdministrativeUnitSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // displayName — required, length, uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate administrative unit "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // description — length only
    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    // visibility — enum
    if (!(VISIBILITY_VALUES as readonly string[]).includes(spec.visibility)) {
      errors.push({
        field: `${prefix}.visibility`,
        message: `Visibility must be one of: ${VISIBILITY_VALUES.join(', ')}`,
        code: 'invalid_visibility',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
