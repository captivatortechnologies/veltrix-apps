import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MARKING_TYPES } from './_shared'

/**
 * Validate marking-definition items: a known marking type, a non-empty definition
 * value, an optional #hex color and a non-negative integer order. Static — no
 * target access required. The definition value doubles as the marking identity, so
 * a duplicate is flagged (last one wins).
 */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one marking definition.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const definitionType = String(item.fields.definition_type ?? '').trim()
    const definition = String(item.fields.definition ?? '').trim()
    const color = String(item.fields.x_opencti_color ?? '').trim()
    const orderRaw = item.fields.x_opencti_order

    if (!MARKING_TYPES.has(definitionType)) {
      errors.push({
        field: `items[${i}].definition_type`,
        message: `Marking type must be one of TLP, PAP, STATEMENT (got "${definitionType}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (!definition) {
      errors.push({ field: `items[${i}].definition`, message: 'Definition value is required.', code: 'EMPTY_DEFINITION' })
    } else {
      const key = definition.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].definition`,
          message: `Definition "${definition}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_DEFINITION',
        })
      } else {
        seen.add(key)
      }
    }

    if (color && !HEX_RE.test(color)) {
      errors.push({
        field: `items[${i}].x_opencti_color`,
        message: `Color "${color}" must be a #RGB or #RRGGBB hex value.`,
        code: 'INVALID_COLOR',
      })
    }

    if (orderRaw !== undefined && orderRaw !== null && orderRaw !== '') {
      const order = Number(orderRaw)
      if (!Number.isFinite(order) || order < 0 || !Number.isInteger(order)) {
        errors.push({
          field: `items[${i}].x_opencti_order`,
          message: `Order "${String(orderRaw)}" must be a non-negative integer.`,
          code: 'INVALID_ORDER',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
