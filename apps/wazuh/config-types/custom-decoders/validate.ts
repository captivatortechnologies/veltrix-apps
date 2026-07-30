import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DECODERS_FILENAME_RE, checkXml } from './_shared'

/**
 * Validate custom-decoders items: a safe .xml filename and a non-empty decoders
 * body that looks like well-formed XML. Static; no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one decoders file.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const filename = String(item.fields.filename ?? '').trim()
    const decodersXml = String(item.fields.decodersXml ?? '').trim()

    if (!filename) {
      errors.push({ field: `items[${i}].filename`, message: 'Filename is required.', code: 'EMPTY_NAME' })
    } else if (!DECODERS_FILENAME_RE.test(filename)) {
      errors.push({ field: `items[${i}].filename`, message: `Filename "${filename}" must be a safe basename ending in .xml (letters, numbers, dot, underscore or hyphen).`, code: 'INVALID_NAME' })
    } else if (seen.has(filename)) {
      warnings.push({ field: `items[${i}].filename`, message: `File ${filename} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(filename)
    }

    if (!decodersXml) {
      errors.push({ field: `items[${i}].decodersXml`, message: 'Decoders XML is required.', code: 'EMPTY_XML' })
    } else {
      const xml = checkXml(decodersXml)
      if (!xml.valid) {
        warnings.push({ field: `items[${i}].decodersXml`, message: `Decoders body may not be well-formed XML (${xml.reason}).`, code: 'MALFORMED_XML' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
