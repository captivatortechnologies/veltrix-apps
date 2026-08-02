import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SCAN_FREQUENCIES, normalizeTargets, text } from './_shared'

/**
 * Validate Scan Task items: a scan name (identity), a site reference, and non-empty targets are
 * required — targets is the only API-required ScanOptions field. The frequency must be one of the
 * runZero vocabulary. Static — no target access required. The (site + scan-name) pair is the
 * upsert identity, so a repeat is flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scan task.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = text(item.fields.scanName)
    const site = text(item.fields.site)
    const frequency = text(item.fields.frequency).toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].scanName`, message: 'Scan name is required.', code: 'EMPTY_NAME' })
    }
    if (!site) {
      errors.push({ field: `items[${i}].site`, message: 'A target site (name or UUID) is required.', code: 'EMPTY_SITE' })
    }
    if (!normalizeTargets(item.fields.targets)) {
      errors.push({
        field: `items[${i}].targets`,
        message: 'Scan targets are required — use "defaults" to scan the site\'s default scope.',
        code: 'EMPTY_TARGETS',
      })
    }
    if (frequency && !(SCAN_FREQUENCIES as readonly string[]).includes(frequency)) {
      errors.push({
        field: `items[${i}].frequency`,
        message: `Frequency "${frequency}" must be one of ${SCAN_FREQUENCIES.join(', ')}.`,
        code: 'INVALID_FREQUENCY',
      })
    }

    if (name && site) {
      const key = `${site.toLowerCase()}::${name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].scanName`,
          message: `Scan "${name}" on site "${site}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_TASK',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
