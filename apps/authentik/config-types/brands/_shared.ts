// Shared helpers for the authentik Brands config type (deploy + rollback +
// drift). Shapes follow the authentik Core API `Brand` / `BrandRequest` /
// `PatchedBrandRequest` schemas — see lib/authentikApi.ts for citations.
//
// IDENTITY: the API path key is a server-assigned UUID (`brand_uuid`,
// `/core/brands/{brand_uuid}/`) — this config type upserts by DOMAIN (list
// `?domain=` → match → PATCH/POST) via the generic `findByField` helper.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AuthentikBrand {
  brand_uuid?: string
  domain?: string
  default?: boolean
  branding_title?: string
  branding_logo?: string
  branding_favicon?: string
  flow_authentication?: string | null
  flow_invalidation?: string | null
  flow_recovery?: string | null
  attributes?: Record<string, unknown>
  [key: string]: unknown
}

export interface ManagedBrandFields {
  domain: string
  default: boolean
  brandingTitle: string
  brandingLogo: string
  brandingFavicon: string
  flowAuthentication: string
  flowInvalidation: string
  flowRecovery: string
  attributes: Record<string, string>
}

export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** Read a `keyvalue` field into a plain string map (object, array-of-pairs, or "k=v" lines). */
export function readAttributes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = String(rec.key ?? rec.name ?? '').trim()
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
    return out
  }
  if (typeof value === 'string' && value.trim()) {
    for (const line of value.split(/[\r\n,]+/)) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) out[k] = line.slice(idx + 1).trim()
      }
    }
  }
  return out
}

export function sameAttributes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => b[k] === a[k])
}

export function readManagedFields(fields: Record<string, unknown>): ManagedBrandFields {
  return {
    domain: String(fields.domain ?? '').trim(),
    default: normalizeBool(fields.default, false),
    brandingTitle: String(fields.branding_title ?? '').trim(),
    brandingLogo: String(fields.branding_logo ?? '').trim(),
    brandingFavicon: String(fields.branding_favicon ?? '').trim(),
    flowAuthentication: String(fields.flow_authentication ?? '').trim(),
    flowInvalidation: String(fields.flow_invalidation ?? '').trim(),
    flowRecovery: String(fields.flow_recovery ?? '').trim(),
    attributes: readAttributes(fields.attributes),
  }
}

/** Managed body shared by create/update. Optional string/flow fields are only sent when declared. */
function buildManagedBody(managed: ManagedBrandFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    domain: managed.domain,
    default: managed.default,
    attributes: managed.attributes,
  }
  if (managed.brandingTitle) body.branding_title = managed.brandingTitle
  if (managed.brandingLogo) body.branding_logo = managed.brandingLogo
  if (managed.brandingFavicon) body.branding_favicon = managed.brandingFavicon
  if (managed.flowAuthentication) body.flow_authentication = managed.flowAuthentication
  if (managed.flowInvalidation) body.flow_invalidation = managed.flowInvalidation
  if (managed.flowRecovery) body.flow_recovery = managed.flowRecovery
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedBrandFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

export function snapshotManagedFields(brand: AuthentikBrand): ManagedBrandFields {
  const attrsSource = brand.attributes && typeof brand.attributes === 'object' ? brand.attributes : {}
  const attributes: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrsSource)) attributes[k] = coerceScalar(v)
  return {
    domain: String(brand.domain ?? '').trim(),
    default: normalizeBool(brand.default, false),
    brandingTitle: String(brand.branding_title ?? '').trim(),
    brandingLogo: String(brand.branding_logo ?? '').trim(),
    brandingFavicon: String(brand.branding_favicon ?? '').trim(),
    flowAuthentication: String(brand.flow_authentication ?? '').trim(),
    flowInvalidation: String(brand.flow_invalidation ?? '').trim(),
    flowRecovery: String(brand.flow_recovery ?? '').trim(),
    attributes,
  }
}

export function sameManagedFields(expected: ManagedBrandFields, actual: ManagedBrandFields): boolean {
  if (expected.domain !== actual.domain) return false
  if (expected.default !== actual.default) return false
  if (expected.brandingTitle && expected.brandingTitle !== actual.brandingTitle) return false
  if (expected.brandingLogo && expected.brandingLogo !== actual.brandingLogo) return false
  if (expected.brandingFavicon && expected.brandingFavicon !== actual.brandingFavicon) return false
  if (expected.flowAuthentication && expected.flowAuthentication !== actual.flowAuthentication) return false
  if (expected.flowInvalidation && expected.flowInvalidation !== actual.flowInvalidation) return false
  if (expected.flowRecovery && expected.flowRecovery !== actual.flowRecovery) return false
  if (!sameAttributes(expected.attributes, actual.attributes)) return false
  return true
}
