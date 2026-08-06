import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractNetworkGroupSpecs, networkGroupKey } from './_shared'

/**
 * Validate network group(s): a required groupName, unique within its
 * declared parent scope. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network group.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNetworkGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.groupName) {
      errors.push({ field: `${prefix}.groupName`, message: 'Group Name is required.', code: 'REQUIRED' })
      return
    }

    const key = `${spec.parentId.trim().toLowerCase()}::${networkGroupKey(spec.groupName)}`
    if (seen.has(key)) {
      warnings.push({
        field: `${prefix}.groupName`,
        message: `Group "${spec.groupName}" is declared more than once under the same parent; the last one wins.`,
        code: 'DUPLICATE_GROUP',
      })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
