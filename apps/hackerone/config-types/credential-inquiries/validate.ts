import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { str } from '../../lib/programScopes'

/**
 * Validate credential-inquiry items: each needs a program handle, the identifier
 * of the structured scope it attaches to, and a non-empty description. Static — no
 * target access required. Identity is (program_handle + asset_identifier); a
 * program has at most one inquiry per scope, so a scope repeated within the same
 * program is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one credential inquiry.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const programHandle = str(item.fields.program_handle)
    const assetIdentifier = str(item.fields.asset_identifier)
    const description = str(item.fields.description)

    if (!programHandle) {
      errors.push({ field: `items[${i}].program_handle`, message: 'Program handle is required.', code: 'EMPTY_PROGRAM' })
    }

    if (!assetIdentifier) {
      errors.push({ field: `items[${i}].asset_identifier`, message: 'Asset identifier is required.', code: 'EMPTY_IDENTIFIER' })
    } else if (programHandle) {
      const key = `${programHandle.toLowerCase()} ${assetIdentifier.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].asset_identifier`,
          message: `Asset "${assetIdentifier}" has more than one credential inquiry for program "${programHandle}"; a program keeps one inquiry per scope, so the last one wins.`,
          code: 'DUPLICATE_INQUIRY',
        })
      } else {
        seen.add(key)
      }
    }

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Inquiry description is required.', code: 'EMPTY_DESCRIPTION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
