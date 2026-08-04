import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const PAYLOAD_SCHEMAS = new Set(['builtInFields', 'allFields', 'raw'])
const FORMATS = new Set(['csv', 'json', 'text'])

/**
 * Validate data-forwarding-rule items: a non-empty indexId and destinationId,
 * and (when set) a recognized payloadSchema/format. Static — no target access
 * required. The indexId is the identity, so a duplicate is flagged (last one
 * wins) — a rule can only exist for one index, matching the Management API.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one data forwarding rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const indexId = String(item.fields.indexId ?? '').trim()
    const destinationId = String(item.fields.destinationId ?? '').trim()
    const payloadSchema = String(item.fields.payloadSchema ?? '').trim()
    const format = String(item.fields.format ?? '').trim()

    if (!indexId) {
      errors.push({ field: `items[${i}].indexId`, message: 'Partition / Scheduled View id is required.', code: 'EMPTY_INDEX_ID' })
    } else {
      if (seen.has(indexId)) {
        warnings.push({
          field: `items[${i}].indexId`,
          message: `Index id "${indexId}" is listed more than once; the last one wins (a rule can only exist for one index).`,
          code: 'DUPLICATE_INDEX_ID',
        })
      } else {
        seen.add(indexId)
      }
    }

    if (!destinationId) {
      errors.push({ field: `items[${i}].destinationId`, message: 'Destination id is required.', code: 'EMPTY_DESTINATION_ID' })
    }

    if (payloadSchema && !PAYLOAD_SCHEMAS.has(payloadSchema)) {
      errors.push({ field: `items[${i}].payloadSchema`, message: 'Payload schema must be builtInFields, allFields or raw.', code: 'INVALID_PAYLOAD_SCHEMA' })
    }

    if (format && !FORMATS.has(format)) {
      errors.push({ field: `items[${i}].format`, message: 'Format must be csv, json or text.', code: 'INVALID_FORMAT' })
    }

    if ((format === 'text' && payloadSchema && payloadSchema !== 'raw') || (payloadSchema === 'raw' && format && format !== 'text')) {
      warnings.push({
        field: `items[${i}].format`,
        message: 'Raw text format and the raw payload schema are meant to be used together — this combination may be rejected by Sumo Logic.',
        code: 'MISMATCHED_FORMAT_SCHEMA',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
