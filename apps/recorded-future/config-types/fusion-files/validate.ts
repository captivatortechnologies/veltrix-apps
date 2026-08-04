import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_CONTENT_LENGTH, hasTraversalSegment, isWritablePath, normalizePath } from './_shared'

/**
 * Validate Fusion File items: a well-formed /home/... path and content within
 * the size bound this app manages as text. Static — no target access required.
 * The path doubles as this item's identity, so a duplicate path is flagged (last
 * one wins). Empty content is allowed (uploads a zero-byte file) but warned about.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Fusion File.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const path = normalizePath(item.fields.path)
    const content = String(item.fields.content ?? '')

    if (!path) {
      errors.push({ field: `items[${i}].path`, message: 'Path is required.', code: 'EMPTY_PATH' })
    } else {
      if (!isWritablePath(path)) {
        errors.push({
          field: `items[${i}].path`,
          message: `Path "${path}" must start with /home/ — /public/... is Recorded Future-managed and read-only.`,
          code: 'READ_ONLY_PATH',
        })
      }
      if (hasTraversalSegment(path)) {
        errors.push({ field: `items[${i}].path`, message: `Path "${path}" may not contain a ".." segment.`, code: 'PATH_TRAVERSAL' })
      }

      const key = path.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].path`,
          message: `Path "${path}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_PATH',
        })
      } else {
        seen.add(key)
      }
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      errors.push({
        field: `items[${i}].content`,
        message: `Content is ${content.length} characters — this app manages Fusion files as text, capped at ${MAX_CONTENT_LENGTH} characters.`,
        code: 'CONTENT_TOO_LARGE',
      })
    }

    if (content.length === 0) {
      warnings.push({
        field: `items[${i}].content`,
        message: `"${path || i}" has no content — deploy will upload a zero-byte file.`,
        code: 'EMPTY_CONTENT',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
