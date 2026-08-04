import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate notifier items: a name, a notifier connector id, and a
 * notifier_configuration that parses as JSON (sent verbatim to OpenCTI as a
 * JSON string — shallow-validated, like other apps' free-form config blobs).
 * Static — no target access required. The name doubles as the notifier
 * identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one notifier.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const connectorId = String(item.fields.notifier_connector_id ?? '').trim()
    const configuration = String(item.fields.notifier_configuration ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Notifier name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Notifier "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!connectorId) {
      errors.push({
        field: `items[${i}].notifier_connector_id`,
        message: 'Notifier connector id is required.',
        code: 'EMPTY_CONNECTOR_ID',
      })
    }

    if (!configuration) {
      errors.push({
        field: `items[${i}].notifier_configuration`,
        message: 'Notifier configuration is required.',
        code: 'EMPTY_CONFIGURATION',
      })
    } else {
      try {
        JSON.parse(configuration)
      } catch {
        errors.push({
          field: `items[${i}].notifier_configuration`,
          message: 'Notifier configuration must be valid JSON.',
          code: 'INVALID_JSON',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
