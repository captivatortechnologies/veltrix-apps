import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readOptionalString, readString, readStringArray } from '../../lib/fields'
import { grantKey, ORGANIZATION_USAGE_VALUES } from './_shared'

/**
 * Validate Auth0 client grant items: a non-empty client_id, a non-empty
 * audience, whitespace-free scope tokens, and a known organization_usage
 * value. Static: no target access required. The (client_id, audience) pair is
 * the upsert identity, so a duplicate pair is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client grant.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const clientId = readString(item.fields.client_id)
    const audience = readString(item.fields.audience)
    const orgUsage = readOptionalString(item.fields.organization_usage) ?? ''

    if (!clientId) {
      errors.push({ field: `items[${i}].client_id`, message: 'Client ID is required.', code: 'EMPTY_CLIENT_ID' })
    }

    if (!audience) {
      errors.push({ field: `items[${i}].audience`, message: 'Audience is required.', code: 'EMPTY_AUDIENCE' })
    }

    if (clientId && audience) {
      const key = grantKey(clientId, audience)
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].audience`,
          message: `Client grant for client_id "${clientId}" + audience "${audience}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_GRANT',
        })
      } else {
        seen.add(key)
      }
    }

    if (!ORGANIZATION_USAGE_VALUES.has(orgUsage)) {
      errors.push({
        field: `items[${i}].organization_usage`,
        message: `Organization usage must be one of deny, allow, require (got "${orgUsage}").`,
        code: 'INVALID_ORGANIZATION_USAGE',
      })
    }

    for (const scope of readStringArray(item.fields.scope)) {
      if (/\s/.test(scope)) {
        errors.push({
          field: `items[${i}].scope`,
          message: `Scope "${scope}" must not contain whitespace.`,
          code: 'INVALID_SCOPE',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
