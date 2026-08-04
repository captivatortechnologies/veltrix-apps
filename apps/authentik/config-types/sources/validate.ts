import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PROVIDER_TYPES, SLUG_PATTERN, SOURCE_TYPES, UUID_PATTERN } from './_shared'

/**
 * Validate authentik Source items: a non-empty name and slug (the upsert
 * identity — also the `{slug}` path segment), a known type, and per-type
 * required fields: Type = OAuth needs `consumer_key` + `consumer_secret` (on
 * create — see _shared.ts's write-only handling) + a known `provider_type`;
 * Type = LDAP needs `server_uri` + `base_dn`. Static (no target access, so a
 * blank secret on what might be an UPDATE cannot be distinguished from a
 * missing one here — deploy resolves that against the live source).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one source.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const slug = String(item.fields.slug ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const authenticationFlow = String(item.fields.authentication_flow ?? '').trim()
    const enrollmentFlow = String(item.fields.enrollment_flow ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Source name is required.', code: 'EMPTY_NAME' })
    }

    if (!slug) {
      errors.push({ field: `items[${i}].slug`, message: 'Slug is required.', code: 'EMPTY_SLUG' })
    } else if (!SLUG_PATTERN.test(slug)) {
      errors.push({ field: `items[${i}].slug`, message: `Slug "${slug}" may only contain letters, numbers, hyphens and underscores.`, code: 'INVALID_SLUG' })
    } else if (seen.has(slug)) {
      warnings.push({ field: `items[${i}].slug`, message: `Slug "${slug}" is listed more than once; the last one wins.`, code: 'DUPLICATE_SLUG' })
    } else {
      seen.add(slug)
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Source type is required.', code: 'EMPTY_TYPE' })
    } else if (!SOURCE_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: `Unsupported source type "${type}".`, code: 'INVALID_TYPE' })
    }

    for (const [flowKey, label] of [['authentication_flow', authenticationFlow], ['enrollment_flow', enrollmentFlow]] as const) {
      if (label && !UUID_PATTERN.test(label)) {
        errors.push({ field: `items[${i}].${flowKey}`, message: `"${label}" is not a valid UUID.`, code: 'INVALID_FLOW_UUID' })
      }
    }

    if (type === 'oauth') {
      const providerType = String(item.fields.provider_type ?? '').trim()
      const consumerKey = String(item.fields.consumer_key ?? '').trim()
      if (!consumerKey) {
        errors.push({ field: `items[${i}].consumer_key`, message: 'Consumer Key is required for Type = OAuth.', code: 'EMPTY_CONSUMER_KEY' })
      }
      if (providerType && !PROVIDER_TYPES.has(providerType)) {
        errors.push({ field: `items[${i}].provider_type`, message: `Unsupported provider type "${providerType}".`, code: 'INVALID_PROVIDER_TYPE' })
      }
    }

    if (type === 'ldap') {
      const serverUri = String(item.fields.server_uri ?? '').trim()
      const baseDn = String(item.fields.base_dn ?? '').trim()
      if (!serverUri) {
        errors.push({ field: `items[${i}].server_uri`, message: 'Server URI is required for Type = LDAP.', code: 'EMPTY_SERVER_URI' })
      }
      if (!baseDn) {
        errors.push({ field: `items[${i}].base_dn`, message: 'Base DN is required for Type = LDAP.', code: 'EMPTY_BASE_DN' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
