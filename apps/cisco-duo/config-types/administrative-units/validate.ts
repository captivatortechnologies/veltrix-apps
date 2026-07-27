import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo administrative-unit constraints -------------------------------

export const MAX_NAME_LENGTH = 255

export interface AdminUnitSpec {
  itemId?: string
  /** name — the logical identity. Duo requires admin-unit names to be unique, so
   *  the app matches on name and stores the admin_unit_id for rename-safety. */
  name: string
  description: string
  restrictByGroups: boolean
  restrictByIntegrations: boolean
}

/** An administrative unit as returned by GET /admin/v1/administrative_units. */
export interface LiveAdminUnit {
  admin_unit_id?: string
  name?: string
  description?: string | null
  restrict_by_groups?: boolean
  restrict_by_integrations?: boolean
  admins?: string[]
  groups?: string[]
  integrations?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

export function extractAdminUnitSpecs(canvas: CanvasSnapshot): AdminUnitSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      restrictByGroups: asBool(f.restrict_by_groups),
      restrictByIntegrations: asBool(f.restrict_by_integrations),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAdminUnitSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate administrative unit "${spec.name}" — Duo requires names to be unique and each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required — the Duo Admin API requires a description when creating an administrative unit', code: 'required' })
    }

    if (spec.restrictByGroups) {
      warnings.push({ field: `${prefix}.restrict_by_groups`, message: 'restrict_by_groups is on but this config type does not manage group membership — assign groups to the unit in the Duo Admin Panel, or its admins will see no users', code: 'unmanaged_membership' })
    }
    if (spec.restrictByIntegrations) {
      warnings.push({ field: `${prefix}.restrict_by_integrations`, message: 'restrict_by_integrations is on but this config type does not manage integration membership — assign integrations to the unit in the Duo Admin Panel, or its admins will see no applications', code: 'unmanaged_membership' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
