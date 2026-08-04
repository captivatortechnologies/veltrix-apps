import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate folder items: a non-empty name and a non-empty parent folder id.
 * Static — no target access required. A duplicate (parentId, name) pair is
 * flagged, since folder names are only unique within their parent.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one folder.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const parentId = String(item.fields.parentId ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Folder name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = `${parentId.toLowerCase()}::${name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Folder "${name}" is listed more than once for the same parent; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!parentId) {
      errors.push({ field: `items[${i}].parentId`, message: 'Parent folder id is required.', code: 'EMPTY_PARENT_ID' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
