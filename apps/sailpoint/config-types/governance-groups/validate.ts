import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC governance group (workgroup) constraints ------------------

export const MAX_NAME_LENGTH = 128

export interface GovernanceGroupSpec {
  itemId?: string
  /** name — the logical identity (matched on; workgroups also expose a name filter). */
  name: string
  description: string
  /** the owning Identity's id (required by ISC). */
  ownerId: string
}

/** A workgroup as returned by GET /workgroups/v1. */
export interface LiveWorkgroup {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractGovernanceGroupSpecs(canvas: CanvasSnapshot): GovernanceGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    description: asString(item.fields?.description),
    ownerId: asString(item.fields?.ownerId),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGovernanceGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate governance group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner Identity id is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
