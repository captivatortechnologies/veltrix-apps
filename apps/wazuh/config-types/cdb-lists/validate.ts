import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { LIST_NAME_RE, isSafeRelativePath, parseEntries } from './_shared'

/**
 * Validate CDB list items: a safe list name, a safe relative path (no absolute
 * root, no `..` traversal), and an `entries` body whose non-blank lines all parse
 * as `key:value` pairs. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one CDB list.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const listName = String(item.fields.listName ?? '').trim()
    const path = String(item.fields.path ?? '').trim()

    if (!listName) {
      errors.push({ field: `items[${i}].listName`, message: 'List name is required.', code: 'EMPTY_NAME' })
    } else if (!LIST_NAME_RE.test(listName)) {
      errors.push({ field: `items[${i}].listName`, message: `List name "${listName}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(listName)) {
      warnings.push({ field: `items[${i}].listName`, message: `List ${listName} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(listName)
    }

    if (!path) {
      errors.push({ field: `items[${i}].path`, message: 'Path is required.', code: 'EMPTY_PATH' })
    } else if (!isSafeRelativePath(path)) {
      errors.push({ field: `items[${i}].path`, message: `Path "${path}" must be a safe relative path (no leading "/" and no ".." segments), e.g. etc/lists/blocklist.`, code: 'INVALID_PATH' })
    }

    const { entries, invalidLines } = parseEntries(item.fields.entries)
    if (invalidLines.length > 0) {
      errors.push({ field: `items[${i}].entries`, message: `Line(s) ${invalidLines.join(', ')} are not valid "key:value" pairs.`, code: 'INVALID_ENTRIES' })
    }
    if (entries.length === 0 && invalidLines.length === 0) {
      warnings.push({ field: `items[${i}].entries`, message: 'This CDB list has no entries — it will be written empty.', code: 'EMPTY_ENTRIES' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
