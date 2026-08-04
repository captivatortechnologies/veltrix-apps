import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ACCOUNT_NAME_FORMATS, str, systemIdentity, toNonNegativeInt, toPositiveInt } from './_shared'

/**
 * Validate managed-system items: a workgroup name, a non-empty system name
 * within a reasonable length, a positive integer platform id, and (when set) a
 * valid account name format. Static — no target access required; the workgroup
 * name is resolved at deploy time, not here. The (workgroup, system name)
 * triple is the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one managed system.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const workgroupName = str(item.fields.workgroupName)
    const systemName = str(item.fields.systemName)
    const platformId = toPositiveInt(item.fields.platformId)
    const accountNameFormat = item.fields.accountNameFormat

    if (!workgroupName) {
      errors.push({ field: `items[${i}].workgroupName`, message: 'Workgroup is required.', code: 'EMPTY_WORKGROUP' })
    }

    if (!systemName) {
      errors.push({ field: `items[${i}].systemName`, message: 'System name is required.', code: 'EMPTY_SYSTEM_NAME' })
    } else if (systemName.length > 128) {
      errors.push({ field: `items[${i}].systemName`, message: 'System name must be 128 characters or fewer.', code: 'SYSTEM_NAME_TOO_LONG' })
    }

    if (platformId === null) {
      errors.push({ field: `items[${i}].platformId`, message: 'Platform ID is required and must be a positive integer.', code: 'INVALID_PLATFORM_ID' })
    }

    if (accountNameFormat !== undefined && accountNameFormat !== null && accountNameFormat !== '') {
      const n = toNonNegativeInt(accountNameFormat)
      if (n === null || !ACCOUNT_NAME_FORMATS.has(n)) {
        errors.push({ field: `items[${i}].accountNameFormat`, message: 'Account name format must be 0 (domain and account), 1 (UPN) or 2 (SAM).', code: 'INVALID_ACCOUNT_NAME_FORMAT' })
      }
    }

    if (workgroupName && systemName) {
      const identity = systemIdentity(workgroupName.toLowerCase(), systemName)
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].systemName`, message: `Managed system ${systemName} in workgroup ${workgroupName} is listed more than once; the last one wins.`, code: 'DUPLICATE_SYSTEM' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
