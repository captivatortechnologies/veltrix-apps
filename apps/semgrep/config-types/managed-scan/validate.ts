import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractManagedScanSpecs } from './_shared'
import { normalizeName } from '../../lib/canvas'

/**
 * Validate Managed Scan items: a non-empty, unique project name per canvas. The
 * two scan toggles are booleans and always valid. Static — no target access.
 * A project with both scans off is allowed (it explicitly disables Managed Scans)
 * but warns, since an item that turns nothing on is usually a mistake.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractManagedScanSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one project.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.projectName) {
      errors.push({ field: `items[${i}].projectName`, message: 'Project name is required.', code: 'EMPTY_PROJECT_NAME' })
      return
    }
    const key = normalizeName(spec.projectName)
    if (seen.has(key)) {
      errors.push({
        field: `items[${i}].projectName`,
        message: `Project "${spec.projectName}" is declared more than once — each project may only appear once.`,
        code: 'DUPLICATE_PROJECT',
      })
    } else {
      seen.add(key)
    }

    if (!spec.fullScanEnabled && !spec.diffScanEnabled) {
      warnings.push({
        field: `items[${i}]`,
        message: `Both Managed Scan modes are off for "${spec.projectName}" — this deploy will disable Managed Scans for the project.`,
        code: 'MANAGED_SCAN_ALL_OFF',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
