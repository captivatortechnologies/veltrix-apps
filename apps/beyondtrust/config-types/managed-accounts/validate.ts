import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CHANGE_FREQUENCY_TYPES, accountIdentity, str, toNonNegativeInt, toPositiveInt } from './_shared'

const CHANGE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Validate managed-account items: a managed system name, a non-empty account
 * name within Password Safe's length limit, a known change-frequency type
 * (with the day count required when frequency is "xdays"), and a well-formed
 * change time. Static — no target access required; the system name is resolved
 * at deploy time, not here. The (account name, domain) pair is the identity
 * within one system, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one managed account.', code: 'EMPTY' })
  }

  const seen = new Map<string, string>()
  items.forEach((item, i) => {
    const systemName = str(item.fields.systemName)
    const accountName = str(item.fields.accountName)
    const domainName = str(item.fields.domainName)
    const description = str(item.fields.description)
    const changeFrequencyType = str(item.fields.changeFrequencyType)
    const changeFrequencyDays = item.fields.changeFrequencyDays
    const changeTime = str(item.fields.changeTime)

    if (!systemName) {
      errors.push({ field: `items[${i}].systemName`, message: 'Managed system is required.', code: 'EMPTY_SYSTEM_NAME' })
    }

    if (!accountName) {
      errors.push({ field: `items[${i}].accountName`, message: 'Account name is required.', code: 'EMPTY_ACCOUNT_NAME' })
    } else if (accountName.length > 245) {
      errors.push({ field: `items[${i}].accountName`, message: 'Account name must be 245 characters or fewer.', code: 'ACCOUNT_NAME_TOO_LONG' })
    }

    if (domainName.length > 50) {
      errors.push({ field: `items[${i}].domainName`, message: 'Domain name must be 50 characters or fewer.', code: 'DOMAIN_TOO_LONG' })
    }

    if (description.length > 1000) {
      errors.push({ field: `items[${i}].description`, message: 'Description must be 1000 characters or fewer.', code: 'DESCRIPTION_TOO_LONG' })
    }

    if (!CHANGE_FREQUENCY_TYPES.has(changeFrequencyType)) {
      errors.push({ field: `items[${i}].changeFrequencyType`, message: 'Change frequency must be one of (inherit), first, last, xdays.', code: 'INVALID_CHANGE_FREQUENCY' })
    }

    if (changeFrequencyType === 'xdays' && toPositiveInt(changeFrequencyDays) === null) {
      errors.push({ field: `items[${i}].changeFrequencyDays`, message: 'Change every N days requires a positive day count.', code: 'MISSING_CHANGE_FREQUENCY_DAYS' })
    } else if (changeFrequencyType !== 'xdays' && changeFrequencyDays !== undefined && changeFrequencyDays !== null && changeFrequencyDays !== '' && toNonNegativeInt(changeFrequencyDays) === null) {
      errors.push({ field: `items[${i}].changeFrequencyDays`, message: 'Change frequency days must be a non-negative integer.', code: 'INVALID_CHANGE_FREQUENCY_DAYS' })
    }

    if (changeTime && !CHANGE_TIME_RE.test(changeTime)) {
      errors.push({ field: `items[${i}].changeTime`, message: 'Change time must be 24-hour HH:MM, e.g. 23:30.', code: 'INVALID_CHANGE_TIME' })
    }

    if (systemName && accountName) {
      const identity = `${systemName.toLowerCase()} ${accountIdentity(accountName, domainName)}`
      const label = domainName ? `${domainName}\\${accountName}` : accountName
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].accountName`, message: `Managed account ${label} on system ${systemName} is listed more than once; the last one wins.`, code: 'DUPLICATE_ACCOUNT' })
      } else {
        seen.set(identity, label)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
