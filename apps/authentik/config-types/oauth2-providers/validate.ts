import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CLIENT_TYPES, UUID_PATTERN, readStringList } from './_shared'

/**
 * Validate authentik OAuth2/OpenID Provider items: a non-empty name (the
 * upsert identity — providers have no user-declared path key), valid-UUID
 * authorization/invalidation flow references (both required by authentik), a
 * known client type, a valid-UUID signing key when set, at least one redirect
 * URI, and valid-UUID property mapping references. Static (no target access):
 * none of the referenced UUIDs (flows, signing key, property mappings) are
 * resolved against a live authentik instance here. A duplicate name is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one OAuth2/OpenID provider.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const authorizationFlow = String(item.fields.authorization_flow ?? '').trim()
    const invalidationFlow = String(item.fields.invalidation_flow ?? '').trim()
    const clientType = String(item.fields.client_type ?? '').trim()
    const signingKey = String(item.fields.signing_key ?? '').trim()
    const redirectUris = readStringList(item.fields.redirect_uris)
    const propertyMappings = readStringList(item.fields.property_mappings)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Provider name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Provider name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name)
    }

    if (!authorizationFlow) {
      errors.push({
        field: `items[${i}].authorization_flow`,
        message: "Authorization flow is required (an existing Flow's UUID).",
        code: 'EMPTY_AUTHORIZATION_FLOW',
      })
    } else if (!UUID_PATTERN.test(authorizationFlow)) {
      errors.push({
        field: `items[${i}].authorization_flow`,
        message: `"${authorizationFlow}" is not a valid UUID.`,
        code: 'INVALID_AUTHORIZATION_FLOW',
      })
    }

    if (!invalidationFlow) {
      errors.push({
        field: `items[${i}].invalidation_flow`,
        message: "Invalidation flow is required (an existing Flow's UUID).",
        code: 'EMPTY_INVALIDATION_FLOW',
      })
    } else if (!UUID_PATTERN.test(invalidationFlow)) {
      errors.push({
        field: `items[${i}].invalidation_flow`,
        message: `"${invalidationFlow}" is not a valid UUID.`,
        code: 'INVALID_INVALIDATION_FLOW',
      })
    }

    if (clientType && !CLIENT_TYPES.has(clientType)) {
      errors.push({
        field: `items[${i}].client_type`,
        message: `Client type must be "confidential" or "public" (got "${clientType}").`,
        code: 'INVALID_CLIENT_TYPE',
      })
    }

    if (signingKey && !UUID_PATTERN.test(signingKey)) {
      errors.push({ field: `items[${i}].signing_key`, message: `"${signingKey}" is not a valid UUID.`, code: 'INVALID_SIGNING_KEY' })
    }

    if (redirectUris.length === 0) {
      errors.push({ field: `items[${i}].redirect_uris`, message: 'At least one redirect URI is required.', code: 'EMPTY_REDIRECT_URIS' })
    }

    for (const pk of propertyMappings) {
      if (!UUID_PATTERN.test(pk)) {
        errors.push({
          field: `items[${i}].property_mappings`,
          message: `"${pk}" is not a valid UUID.`,
          code: 'INVALID_PROPERTY_MAPPING',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
