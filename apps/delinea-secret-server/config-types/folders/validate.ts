import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate folder items: a non-empty folder name (its identity within a parent).
 * The parent folder name is optional (blank → root). Static — no target access
 * required. A folder's identity is its name WITHIN a parent, so a duplicate
 * name+parent pair is flagged (last one wins).
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
    const name = String(item.fields.folderName ?? '').trim()
    const parent = String(item.fields.parentFolderName ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].folderName`, message: 'Folder name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (name.length > 255) {
      errors.push({ field: `items[${i}].folderName`, message: `Folder name "${name}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    const key = `${parent.toLowerCase()}//${name.toLowerCase()}`
    if (seen.has(key)) {
      warnings.push({
        field: `items[${i}].folderName`,
        message: `Folder "${name}"${parent ? ` under "${parent}"` : ' at root'} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_FOLDER',
      })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
