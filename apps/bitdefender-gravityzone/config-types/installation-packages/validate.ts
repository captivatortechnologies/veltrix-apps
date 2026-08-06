import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractInstallationPackageSpecs, installationPackageKey, parsePackageJsonFields } from './_shared'

const VALID_PRODUCT_TYPES = new Set([0, 3, 5])

/**
 * Validate installation package(s): a required packageName, unique across
 * declarations, a documented productType, and parseable JSON for every
 * Advanced sub-object. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one installation package.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractInstallationPackageSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.packageName) {
      errors.push({ field: `${prefix}.packageName`, message: 'Package Name is required.', code: 'REQUIRED' })
      return
    }

    const key = installationPackageKey(spec.packageName)
    if (seen.has(key)) {
      warnings.push({
        field: `${prefix}.packageName`,
        message: `Package "${spec.packageName}" is declared more than once; the last one wins.`,
        code: 'DUPLICATE_PACKAGE',
      })
    } else {
      seen.add(key)
    }

    if (spec.productType !== undefined && !VALID_PRODUCT_TYPES.has(spec.productType)) {
      errors.push({
        field: `${prefix}.productType`,
        message: `Product Type ${spec.productType} is not one of the documented values (0, 3, 5).`,
        code: 'INVALID_PRODUCT_TYPE',
      })
    }

    const { errors: jsonErrors } = parsePackageJsonFields(spec)
    for (const message of jsonErrors) {
      errors.push({ field: `${prefix}.advanced`, message, code: 'INVALID_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
