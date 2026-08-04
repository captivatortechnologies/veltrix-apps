import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { directoryIdentity, str, toPositiveInt } from './_shared'

/**
 * Validate directory items: a workgroup name, a positive integer platform id,
 * and a non-empty domain name within Password Safe's length limits (plus
 * optional forest / NetBIOS name limits). Static — no target access required;
 * the workgroup name is resolved at deploy time, not here. The (workgroup,
 * domain) pair is the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one directory.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const workgroupName = str(item.fields.workgroupName)
    const platformId = toPositiveInt(item.fields.platformId)
    const domainName = str(item.fields.domainName)
    const forestName = str(item.fields.forestName)
    const netBiosName = str(item.fields.netBiosName)

    if (!workgroupName) {
      errors.push({ field: `items[${i}].workgroupName`, message: 'Workgroup is required.', code: 'EMPTY_WORKGROUP' })
    }

    if (platformId === null) {
      errors.push({ field: `items[${i}].platformId`, message: 'Platform ID is required and must be a positive integer.', code: 'INVALID_PLATFORM_ID' })
    }

    if (!domainName) {
      errors.push({ field: `items[${i}].domainName`, message: 'Domain name is required.', code: 'EMPTY_DOMAIN_NAME' })
    } else if (domainName.length > 128) {
      errors.push({ field: `items[${i}].domainName`, message: 'Domain name must be 128 characters or fewer.', code: 'DOMAIN_NAME_TOO_LONG' })
    }

    if (forestName.length > 64) {
      errors.push({ field: `items[${i}].forestName`, message: 'Forest name must be 64 characters or fewer.', code: 'FOREST_NAME_TOO_LONG' })
    }

    if (netBiosName.length > 15) {
      errors.push({ field: `items[${i}].netBiosName`, message: 'NetBIOS name must be 15 characters or fewer.', code: 'NETBIOS_NAME_TOO_LONG' })
    }

    if (workgroupName && domainName) {
      const identity = directoryIdentity(workgroupName.toLowerCase(), domainName)
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].domainName`, message: `Directory ${domainName} in workgroup ${workgroupName} is listed more than once; the last one wins.`, code: 'DUPLICATE_DIRECTORY' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
