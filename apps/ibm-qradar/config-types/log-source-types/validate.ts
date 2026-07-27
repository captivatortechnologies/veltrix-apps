import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar custom log source type (DSM) constraints ---------------------
//
// Bounded scope: manage a CUSTOM log source type's name plus an optional default
// protocol (declared by name, resolved to default_protocol_id in deploy). Only
// custom types (internal === false) are writable; built-in types are protected,
// so deploy refuses to modify them and reconcile only deletes types this app
// created.

export interface LogSourceTypeSpec {
  itemId?: string
  /** name — the custom log source type's identity (matched by name, rename-safe by id). */
  name: string
  /** optional default protocol name, resolved to default_protocol_id in deploy. */
  defaultProtocolName: string
}

/** A log source type as returned by GET .../log_source_types. */
export interface LiveLogSourceType {
  id?: number
  name?: string
  internal?: boolean
  custom?: boolean
  default_protocol_id?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractLogSourceTypeSpecs(canvas: CanvasSnapshot): LogSourceTypeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      defaultProtocolName: asString(f.defaultProtocolName),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLogSourceTypeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > 241) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 241 characters or fewer', code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate log source type "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
