import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { str } from './_shared'

/**
 * Validate asset-scope items: each needs an organization handle, a program
 * handle and an asset identifier. Static — no target access required. Identity
 * is (organization_handle + program_handle + asset_identifier) — an asset
 * attaches to one program at most once, so a repeat within the same
 * organization+program is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one asset scope.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const organizationHandle = str(item.fields.organization_handle)
    const programHandle = str(item.fields.program_handle)
    const assetIdentifier = str(item.fields.asset_identifier)

    if (!organizationHandle) {
      errors.push({ field: `items[${i}].organization_handle`, message: 'Organization handle is required.', code: 'EMPTY_ORGANIZATION' })
    }

    if (!programHandle) {
      errors.push({ field: `items[${i}].program_handle`, message: 'Program handle is required.', code: 'EMPTY_PROGRAM' })
    }

    if (!assetIdentifier) {
      errors.push({ field: `items[${i}].asset_identifier`, message: 'Asset identifier is required.', code: 'EMPTY_IDENTIFIER' })
    } else if (organizationHandle && programHandle) {
      const key = `${organizationHandle.toLowerCase()} ${programHandle.toLowerCase()} ${assetIdentifier.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].asset_identifier`,
          message: `Asset "${assetIdentifier}" has more than one scope attachment declared for program "${programHandle}"; the last one wins.`,
          code: 'DUPLICATE_ASSET_SCOPE',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
