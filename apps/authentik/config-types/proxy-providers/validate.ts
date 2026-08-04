import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PROXY_MODES, UUID_PATTERN, readStringList } from './_shared'

/**
 * Validate authentik Proxy Provider items: a non-empty name (the upsert
 * identity), valid-UUID flow references (both required), a known mode, a
 * required external host, and valid-UUID property mapping references.
 * `internal_host` is required only in "proxy" mode (forwardAuth modes do not
 * use it). Static (no target access).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one proxy provider.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const authorizationFlow = String(item.fields.authorization_flow ?? '').trim()
    const invalidationFlow = String(item.fields.invalidation_flow ?? '').trim()
    const mode = String(item.fields.mode ?? '').trim()
    const internalHost = String(item.fields.internal_host ?? '').trim()
    const externalHost = String(item.fields.external_host ?? '').trim()
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

    if (mode && !PROXY_MODES.has(mode)) {
      errors.push({ field: `items[${i}].mode`, message: `Mode must be "proxy", "forward_single" or "forward_domain" (got "${mode}").`, code: 'INVALID_MODE' })
    }

    if (!externalHost) {
      errors.push({ field: `items[${i}].external_host`, message: 'External host is required.', code: 'EMPTY_EXTERNAL_HOST' })
    }

    if ((mode || 'proxy') === 'proxy' && !internalHost) {
      errors.push({ field: `items[${i}].internal_host`, message: 'Internal host is required in "proxy" mode.', code: 'EMPTY_INTERNAL_HOST' })
    }

    for (const pk of propertyMappings) {
      if (!UUID_PATTERN.test(pk)) {
        errors.push({ field: `items[${i}].property_mappings`, message: `"${pk}" is not a valid UUID.`, code: 'INVALID_PROPERTY_MAPPING' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
