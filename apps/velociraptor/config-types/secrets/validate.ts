import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import { parseSecretPairs } from './_shared'

/**
 * Validate secrets items: each needs a name (identity), a type, and content that
 * parses into at least one "key: value" pair. Static — no target access
 * required. The name is the upsert identity, so a duplicate name is flagged
 * (last one wins). Usernames/org ids are left freeform, matching this app's
 * existing leniency for Velociraptor identities (see users-acls).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one secret.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const secretData = String(item.fields.secretData ?? '')
    const visibleToAllOrgs = asBool(item.fields.visibleToAllOrgs, false)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Secret "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Type is required.', code: 'EMPTY_TYPE' })
    }

    if (!secretData.trim()) {
      errors.push({ field: `items[${i}].secretData`, message: 'Secret content is required.', code: 'EMPTY_SECRET_DATA' })
    } else if (Object.keys(parseSecretPairs(secretData)).length === 0) {
      errors.push({
        field: `items[${i}].secretData`,
        message: 'Secret content must have at least one "key: value" line.',
        code: 'INVALID_SECRET_DATA',
      })
    }

    const grantedUsers = splitList(item.fields.grantedUsers)
    const grantedOrgs = splitList(item.fields.grantedOrgs)
    if (grantedUsers.length === 0 && grantedOrgs.length === 0 && !visibleToAllOrgs) {
      warnings.push({
        field: `items[${i}].grantedUsers`,
        message: `Secret "${name || '(unnamed)'}" grants no users or orgs and is not visible to all orgs — only a server admin will be able to read it.`,
        code: 'NO_GRANTS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
