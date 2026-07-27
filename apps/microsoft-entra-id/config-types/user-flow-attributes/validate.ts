import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra custom user-flow-attribute constraints ----------------------------
//
// Only "custom" attributes are managed; built-in attributes are read-only.

export const MAX_DISPLAY_NAME_LENGTH = 256
export const DATA_TYPES = new Set(['string', 'boolean', 'int64', 'stringCollection', 'dateTime'])

export interface UserFlowAttributeSpec {
  itemId?: string
  /** displayName — the logical identity live attributes are matched on. */
  name: string
  dataType: string
  description: string
}

/** A user flow attribute as returned by Graph. */
export interface LiveUserFlowAttribute {
  id?: string
  displayName?: string
  dataType?: string
  userFlowAttributeType?: string
  description?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractUserFlowAttributeSpecs(canvas: CanvasSnapshot): UserFlowAttributeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      dataType: asString(f.dataType),
      description: asString(f.description),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractUserFlowAttributeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

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
          message: `Duplicate attribute "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!spec.dataType) {
      errors.push({ field: `${prefix}.dataType`, message: 'Data type is required', code: 'required' })
    } else if (!DATA_TYPES.has(spec.dataType)) {
      errors.push({
        field: `${prefix}.dataType`,
        message: `Data type must be one of ${[...DATA_TYPES].join(', ')}`,
        code: 'invalid_data_type',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
