import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, SGACL_NAME_RE, IP_VERSIONS, specFromItem } from './_shared'

/**
 * Validate SGACL items: a non-empty, uniquely-named ACL matching ISE's naming
 * rule (starts with a letter, then alnum/underscore), non-empty ACL content,
 * and a valid IP version.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Security Group ACL.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const rawVersion = String(item.fields.ip_version ?? '').trim().toUpperCase()

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'SGACL name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH || !SGACL_NAME_RE.test(spec.name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `SGACL name must start with a letter, contain only letters/numbers/underscores, and be ${MAX_NAME_LENGTH} characters or fewer (got "${spec.name}").`,
        code: 'INVALID_NAME',
      })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `SGACL name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (rawVersion && !IP_VERSIONS.has(rawVersion)) {
      errors.push({ field: `items[${i}].ip_version`, message: `IP version must be one of ${[...IP_VERSIONS].join(', ')} (got "${rawVersion}").`, code: 'INVALID_IP_VERSION' })
    }

    if (!spec.aclContent) {
      errors.push({ field: `items[${i}].acl_content`, message: 'ACL content is required — ISE rejects an empty SGACL.', code: 'EMPTY_ACL_CONTENT' })
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
