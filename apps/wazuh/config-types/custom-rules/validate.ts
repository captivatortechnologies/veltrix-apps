import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { RULES_FILENAME_RE, checkXml } from './_shared'

/**
 * Validate custom-rules items: a safe .xml filename and a non-empty rules body
 * that looks like well-formed XML. Static; no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one rules file.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const filename = String(item.fields.filename ?? '').trim()
    const rulesXml = String(item.fields.rulesXml ?? '').trim()

    if (!filename) {
      errors.push({ field: `items[${i}].filename`, message: 'Filename is required.', code: 'EMPTY_NAME' })
    } else if (!RULES_FILENAME_RE.test(filename)) {
      errors.push({ field: `items[${i}].filename`, message: `Filename "${filename}" must be a safe basename ending in .xml (letters, numbers, dot, underscore or hyphen).`, code: 'INVALID_NAME' })
    } else if (seen.has(filename)) {
      warnings.push({ field: `items[${i}].filename`, message: `File ${filename} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(filename)
    }

    if (!rulesXml) {
      errors.push({ field: `items[${i}].rulesXml`, message: 'Rules XML is required.', code: 'EMPTY_XML' })
    } else {
      const xml = checkXml(rulesXml)
      if (!xml.valid) {
        warnings.push({ field: `items[${i}].rulesXml`, message: `Rules body may not be well-formed XML (${xml.reason}).`, code: 'MALFORMED_XML' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
