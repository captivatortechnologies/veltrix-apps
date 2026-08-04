import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'
import { extractSpecs } from './_shared'

/**
 * Validate report-format items: either an existing reportFormatId OR a
 * cloneFrom base must be declared (both UUID-shaped when present). Static —
 * no gvmd access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one report format.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  extractSpecs(items).forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (spec.reportFormatId && !UUID_RE.test(spec.reportFormatId)) {
      errors.push({ field: `${prefix}.reportFormatId`, message: `"${spec.reportFormatId}" must be a GMP report_format UUID.`, code: 'INVALID_REPORT_FORMAT_ID' })
    }
    if (spec.cloneFrom && !UUID_RE.test(spec.cloneFrom)) {
      errors.push({ field: `${prefix}.cloneFrom`, message: `"${spec.cloneFrom}" must be a GMP report_format UUID.`, code: 'INVALID_CLONE_FROM' })
    }

    if (!spec.reportFormatId && !spec.cloneFrom) {
      errors.push({
        field: `${prefix}.reportFormatId`,
        message: 'Either an existing Report Format UUID or a Clone From base UUID is required.',
        code: 'EMPTY_TARGET',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
