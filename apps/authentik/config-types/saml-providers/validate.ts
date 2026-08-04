import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SP_BINDINGS, UUID_PATTERN, readStringList } from './_shared'

/**
 * Validate authentik SAML Provider items: a non-empty name (the upsert
 * identity), valid-UUID authorization/invalidation flow references (both
 * required), a non-empty ACS URL (required), a known SP binding, and
 * valid-UUID property mapping references. Static (no target access).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one SAML provider.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const authorizationFlow = String(item.fields.authorization_flow ?? '').trim()
    const invalidationFlow = String(item.fields.invalidation_flow ?? '').trim()
    const acsUrl = String(item.fields.acs_url ?? '').trim()
    const spBinding = String(item.fields.sp_binding ?? '').trim()
    const propertyMappings = readStringList(item.fields.property_mappings)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Provider name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Provider name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!authorizationFlow) {
      errors.push({ field: `items[${i}].authorization_flow`, message: "Authorization flow is required (an existing Flow's UUID).", code: 'EMPTY_AUTHORIZATION_FLOW' })
    } else if (!UUID_PATTERN.test(authorizationFlow)) {
      errors.push({ field: `items[${i}].authorization_flow`, message: `"${authorizationFlow}" is not a valid UUID.`, code: 'INVALID_AUTHORIZATION_FLOW' })
    }

    if (!invalidationFlow) {
      errors.push({ field: `items[${i}].invalidation_flow`, message: "Invalidation flow is required (an existing Flow's UUID).", code: 'EMPTY_INVALIDATION_FLOW' })
    } else if (!UUID_PATTERN.test(invalidationFlow)) {
      errors.push({ field: `items[${i}].invalidation_flow`, message: `"${invalidationFlow}" is not a valid UUID.`, code: 'INVALID_INVALIDATION_FLOW' })
    }

    if (!acsUrl) {
      errors.push({ field: `items[${i}].acs_url`, message: 'ACS URL is required.', code: 'EMPTY_ACS_URL' })
    }

    if (spBinding && !SP_BINDINGS.has(spBinding)) {
      errors.push({ field: `items[${i}].sp_binding`, message: `SP binding must be "redirect" or "post" (got "${spBinding}").`, code: 'INVALID_SP_BINDING' })
    }

    for (const pk of propertyMappings) {
      if (!UUID_PATTERN.test(pk)) {
        errors.push({ field: `items[${i}].property_mappings`, message: `"${pk}" is not a valid UUID.`, code: 'INVALID_PROPERTY_MAPPING' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
