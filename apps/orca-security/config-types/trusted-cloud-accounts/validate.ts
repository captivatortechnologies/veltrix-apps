import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CLOUD_PROVIDERS } from './_shared'

/**
 * Validate trusted-cloud-account items: a non-empty account name (the
 * identity), a non-empty description (required by the API), a known cloud
 * provider and a non-empty cloud account id. Static — no target access
 * required. A duplicate account name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one trusted cloud account.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const accountName = String(item.fields.accountName ?? '').trim()
    const description = String(item.fields.description ?? '').trim()
    const cloudProvider = String(item.fields.cloudProvider ?? '').trim()
    const cloudAccountId = String(item.fields.cloudAccountId ?? '').trim()

    if (!accountName) {
      errors.push({ field: `items[${i}].accountName`, message: 'Account name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(accountName)) {
      warnings.push({ field: `items[${i}].accountName`, message: `Account name "${accountName}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(accountName)
    }

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Description is required by the Orca API.', code: 'EMPTY_DESCRIPTION' })
    }

    if (!CLOUD_PROVIDERS.has(cloudProvider)) {
      errors.push({
        field: `items[${i}].cloudProvider`,
        message: `Cloud provider must be one of ${[...CLOUD_PROVIDERS].join(', ')} (got "${cloudProvider}").`,
        code: 'INVALID_CLOUD_PROVIDER',
      })
    }

    if (!cloudAccountId) {
      errors.push({ field: `items[${i}].cloudAccountId`, message: 'Cloud account ID is required.', code: 'EMPTY_ACCOUNT_ID' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
