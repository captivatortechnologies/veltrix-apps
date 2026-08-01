import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SCRIPT_FILE_TYPES, expectedExtension, fileNameMatchesType } from './_shared'

/**
 * Validate custom-script items: a file name with a .ps1/.sh extension, a known
 * file type that matches that extension, non-empty contents and a description
 * within length. Static — no target access required. The file name doubles as the
 * script's identity, so a duplicate file name is flagged (last one wins).
 */
const FILENAME_RE = /^[^\\/:*?"<>|]+\.(ps1|sh)$/i
const MAX_DESCRIPTION = 500
const MAX_CONTENT = 100_000

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom script.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const fileName = String(item.fields.fileName ?? '').trim()
    const fileType = String(item.fields.fileType ?? '').trim()
    const content = String(item.fields.scriptContent ?? '')
    const description = String(item.fields.description ?? '').trim()

    if (!fileName) {
      errors.push({ field: `items[${i}].fileName`, message: 'File name is required.', code: 'EMPTY_FILENAME' })
    } else {
      if (!FILENAME_RE.test(fileName)) {
        errors.push({
          field: `items[${i}].fileName`,
          message: `File name "${fileName}" must end in .ps1 (PowerShell) or .sh (Bash) and omit path separators.`,
          code: 'INVALID_FILENAME',
        })
      }
      const key = fileName
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].fileName`, message: `Script ${fileName} is listed more than once; the last one wins.`, code: 'DUPLICATE_FILENAME' })
      } else {
        seen.add(key)
      }
    }

    if (!SCRIPT_FILE_TYPES.has(fileType)) {
      errors.push({
        field: `items[${i}].fileType`,
        message: `File type must be powershell or bash (got "${fileType}").`,
        code: 'INVALID_FILE_TYPE',
      })
    } else if (fileName && FILENAME_RE.test(fileName) && !fileNameMatchesType(fileName, fileType)) {
      errors.push({
        field: `items[${i}].fileName`,
        message: `File name "${fileName}" must use the ${expectedExtension(fileType)} extension for a ${fileType} script.`,
        code: 'EXTENSION_TYPE_MISMATCH',
      })
    }

    if (!content.trim()) {
      errors.push({ field: `items[${i}].scriptContent`, message: 'Script content is required.', code: 'EMPTY_CONTENT' })
    } else if (content.length > MAX_CONTENT) {
      errors.push({
        field: `items[${i}].scriptContent`,
        message: `Script content must be ${MAX_CONTENT} characters or fewer (got ${content.length}).`,
        code: 'CONTENT_TOO_LONG',
      })
    }

    if (description.length > MAX_DESCRIPTION) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION} characters or fewer (got ${description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
