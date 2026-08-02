import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ELEVATION_COMMANDS, accountIdentity, str, toPlatformId } from './_shared'

/**
 * Validate functional-account items: a positive integer Platform ID, a non-empty
 * account name within Password Safe's length limits, and a known elevation
 * command. Static — no target access required. The (platform, domain, account)
 * triple is the account identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one functional account.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const accountName = str(item.fields.accountName)
    const domainName = str(item.fields.domainName)
    const displayName = str(item.fields.displayName)
    const description = str(item.fields.description)
    const elevationCommand = str(item.fields.elevationCommand)
    const platformId = toPlatformId(item.fields.platformId)

    if (!accountName) {
      errors.push({ field: `items[${i}].accountName`, message: 'Account name is required.', code: 'EMPTY_ACCOUNT_NAME' })
    } else if (accountName.length > 245) {
      errors.push({ field: `items[${i}].accountName`, message: 'Account name must be 245 characters or fewer.', code: 'ACCOUNT_NAME_TOO_LONG' })
    }

    if (platformId === null) {
      errors.push({ field: `items[${i}].platformId`, message: 'Platform ID is required and must be a positive integer.', code: 'INVALID_PLATFORM_ID' })
    }

    if (domainName.length > 50) {
      errors.push({ field: `items[${i}].domainName`, message: 'Domain name must be 50 characters or fewer.', code: 'DOMAIN_TOO_LONG' })
    }

    if (displayName.length > 100) {
      errors.push({ field: `items[${i}].displayName`, message: 'Display name must be 100 characters or fewer.', code: 'DISPLAY_TOO_LONG' })
    }

    if (description.length > 1000) {
      errors.push({ field: `items[${i}].description`, message: 'Description must be 1000 characters or fewer.', code: 'DESCRIPTION_TOO_LONG' })
    }

    if (!ELEVATION_COMMANDS.has(elevationCommand)) {
      errors.push({ field: `items[${i}].elevationCommand`, message: `Elevation command must be one of none, sudo, pbrun, pmrun (got "${elevationCommand}").`, code: 'INVALID_ELEVATION' })
    }

    if (accountName && platformId !== null) {
      const identity = accountIdentity(platformId, domainName, accountName)
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].accountName`, message: `Functional account ${domainName ? `${domainName}\\` : ''}${accountName} on platform ${platformId} is listed more than once; the last one wins.`, code: 'DUPLICATE_ACCOUNT' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
