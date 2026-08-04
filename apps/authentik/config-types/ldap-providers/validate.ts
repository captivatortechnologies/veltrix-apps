import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { LDAP_ACCESS_MODES, UUID_PATTERN, readStringList } from './_shared'

/**
 * Validate authentik LDAP Provider items: a non-empty name (the upsert
 * identity), valid-UUID flow references (both required), a required base DN,
 * known search/bind modes, and valid-UUID property mapping references.
 * Static (no target access).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one LDAP provider.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const authorizationFlow = String(item.fields.authorization_flow ?? '').trim()
    const invalidationFlow = String(item.fields.invalidation_flow ?? '').trim()
    const baseDn = String(item.fields.base_dn ?? '').trim()
    const searchMode = String(item.fields.search_mode ?? '').trim()
    const bindMode = String(item.fields.bind_mode ?? '').trim()
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

    if (!baseDn) {
      errors.push({ field: `items[${i}].base_dn`, message: 'Base DN is required.', code: 'EMPTY_BASE_DN' })
    }

    if (searchMode && !LDAP_ACCESS_MODES.has(searchMode)) {
      errors.push({ field: `items[${i}].search_mode`, message: `Search mode must be "direct" or "cached" (got "${searchMode}").`, code: 'INVALID_SEARCH_MODE' })
    }
    if (bindMode && !LDAP_ACCESS_MODES.has(bindMode)) {
      errors.push({ field: `items[${i}].bind_mode`, message: `Bind mode must be "direct" or "cached" (got "${bindMode}").`, code: 'INVALID_BIND_MODE' })
    }

    for (const pk of propertyMappings) {
      if (!UUID_PATTERN.test(pk)) {
        errors.push({ field: `items[${i}].property_mappings`, message: `"${pk}" is not a valid UUID.`, code: 'INVALID_PROPERTY_MAPPING' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
