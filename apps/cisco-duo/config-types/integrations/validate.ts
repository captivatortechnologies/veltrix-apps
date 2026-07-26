import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo integration constraints ---------------------------------------

export const MAX_NAME_LENGTH = 255

export interface IntegrationSpec {
  itemId?: string
  /** name — the logical identity (integrations are addressed by integration_key). */
  name: string
  /** integration type (e.g. websdk, authapi, adminapi) — immutable after create. */
  type: string
}

/** An integration as returned by GET /admin/v1/integrations. */
export interface LiveIntegration {
  integration_key?: string
  name?: string
  type?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractIntegrationSpecs(canvas: CanvasSnapshot): IntegrationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    type: asString(item.fields?.type),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIntegrationSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate integration "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    // The Duo Admin API validates the specific type enum; here it's required.
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Type is required (e.g. websdk, authapi, adminapi)', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
