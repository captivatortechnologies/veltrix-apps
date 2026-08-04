import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Jamf Pro Buildings — modern API (GET/POST/PUT/DELETE /v1/buildings).
// https://developer.jamf.com/jamf-pro/reference/get_v1-buildings — name plus
// an optional postal address. Referenced by name from scoping fields on
// other config types (e.g. restricted-software).

export interface BuildingSpec {
  sectionName: string
  name: string
  streetAddress1: string
  streetAddress2: string
  city: string
  stateProvince: string
  zipPostalCode: string
  country: string
}

export interface LiveBuilding {
  id?: string
  name?: string
  streetAddress1?: string | null
  streetAddress2?: string | null
  city?: string | null
  stateProvince?: string | null
  zipPostalCode?: string | null
  country?: string | null
}

export function buildingKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexBuildingsByName(buildings: LiveBuilding[]): Map<string, LiveBuilding> {
  const byName = new Map<string, LiveBuilding>()
  for (const b of buildings) {
    if (!b.name) continue
    const key = buildingKey(b.name)
    if (!byName.has(key)) byName.set(key, b)
  }
  return byName
}

export function extractBuildingSpecs(canvas: CanvasSnapshot): BuildingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      streetAddress1: str(fields.street_address_1),
      streetAddress2: str(fields.street_address_2),
      city: str(fields.city),
      stateProvince: str(fields.state_province),
      zipPostalCode: str(fields.zip_postal_code),
      country: str(fields.country),
    }
  })
}

export function buildBuildingBody(spec: BuildingSpec): Record<string, unknown> {
  return {
    name: spec.name,
    streetAddress1: spec.streetAddress1,
    streetAddress2: spec.streetAddress2,
    city: spec.city,
    stateProvince: spec.stateProvince,
    zipPostalCode: spec.zipPostalCode,
    country: spec.country,
  }
}

/** Validate building configurations: name required and unique (case-insensitive). Address fields are all optional/nullable. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBuildingSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Building name is required', code: 'required' })
    }

    if (spec.name) {
      const key = buildingKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate building "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_building',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
