import type { CanvasSnapshot, PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { items } from '../lib/catoPolicy'
import { buildRef } from '../../lib/cato'

export interface CustomApplicationSpec {
  name: string
  description: string
  category: string[]
  criteriaJson?: string
}

/** Parse a JSON-array field; returns null for blank input, undefined for invalid/non-array JSON. */
export function parseJsonArray(raw: unknown): unknown[] | null | undefined {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function splitTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Extract one Custom Application spec per canvas item. */
export function extractCustomApplicationSpecs(canvas: CanvasSnapshot): CustomApplicationSpec[] {
  return items(canvas).map((item) => {
    const fields = item.fields ?? {}
    return {
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      category: splitTags(fields.category),
      criteriaJson: typeof fields.criteria_json === 'string' ? fields.criteria_json : undefined,
    }
  })
}

/** Build the addCustomApplication/updateCustomApplication `input` body (add and update share the same shape here). */
export function buildCustomApplicationInput(spec: CustomApplicationSpec): Record<string, unknown> {
  const criteria = spec.criteriaJson ? parseJsonArray(spec.criteriaJson) : []
  return {
    name: spec.name,
    description: spec.description || undefined,
    category: spec.category.map((name) => buildRef(name)),
    criteria: Array.isArray(criteria) ? criteria : [],
  }
}

/**
 * Validate Custom Application items. Static only - no target access:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - criteria_json is required and must parse as a JSON array
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractCustomApplicationSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate custom application "${spec.name}" - each may only be declared once.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (!spec.criteriaJson) {
      errors.push({ field: `${prefix}.criteria_json`, message: 'Criteria (JSON array) is required.', code: 'EMPTY_CRITERIA' })
    } else {
      const parsed = parseJsonArray(spec.criteriaJson)
      if (parsed === undefined) {
        errors.push({ field: `${prefix}.criteria_json`, message: 'Criteria must be a valid JSON array.', code: 'INVALID_JSON' })
      } else if (parsed && parsed.length === 0) {
        errors.push({ field: `${prefix}.criteria_json`, message: 'Criteria must contain at least one entry.', code: 'EMPTY_CRITERIA_ARRAY' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
