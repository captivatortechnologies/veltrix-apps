// Shared helpers for the Authorization Profiles config type (validate + deploy
// + rollback + drift). Field shapes follow the ISE ERS AuthorizationProfile
// resource (/ers/config/authorizationprofile) — verified against the official
// Cisco ISE Ansible collection (github.com/CiscoISE/ansible-ise,
// plugins/modules/authorization_profile.py), whose modules are generated from
// Cisco's own ERS/OpenAPI definitions.
//
// Scoped to STANDARD ("SWITCH") profiles only. Explicitly out of scope (see
// the app README): TrustSec/TACACS+ profile types, ipv6DaclName /
// ipv6ACLFilter / airespaceIPv6ACL, macSecPolicy, webRedirection (portal
// profiles), reauth (periodic re-authentication) and the vendor-specific
// asaVpn / avcProfile / interfaceTemplate / serviceTemplate / autoSmartPort /
// uniqueIdentifier fields.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { AuthorizationProfile, AuthorizationProfileAdvancedAttribute } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000
export const ACCESS_TYPES = new Set(['ACCESS_ACCEPT', 'ACCESS_REJECT'])
export const DEFAULT_ACCESS_TYPE = 'ACCESS_ACCEPT'
/** This app manages only standard (non-TrustSec, non-TACACS+) profiles. */
export const AUTHZ_PROFILE_TYPE = 'SWITCH' as const

export interface ProfileSpec {
  name: string
  description: string
  accessType: string
  acl: string
  daclName: string
  vlanName: string
  vlanTag: number | null
  airespaceAcl: string
  advancedAttributes: AuthorizationProfileAdvancedAttribute[]
}

export interface ParsedAdvancedAttributes {
  attributes: AuthorizationProfileAdvancedAttribute[]
  error?: string
}

/**
 * Parse the `advanced_attributes` JSON-textarea field into a validated array of
 * `{ leftHandSideDictionaryAttribute, rightHandSideAttributeValue }` pairs.
 * Mirrors the graylog app's `parseRules` convention for a JSON-array canvas
 * field: an empty/blank value is a valid empty list; malformed JSON is a
 * structured error rather than a thrown exception.
 */
export function parseAdvancedAttributes(value: unknown): ParsedAdvancedAttributes {
  if (value == null || value === '') return { attributes: [] }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { attributes: [] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { attributes: [], error: `advanced_attributes is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (!Array.isArray(raw)) {
    return { attributes: [], error: 'advanced_attributes must be a JSON array of { leftHandSideDictionaryAttribute, rightHandSideAttributeValue } objects' }
  }
  const attributes: AuthorizationProfileAdvancedAttribute[] = raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    return {
      leftHandSideDictionaryAttribute: o.leftHandSideDictionaryAttribute == null ? '' : String(o.leftHandSideDictionaryAttribute),
      rightHandSideAttributeValue: o.rightHandSideAttributeValue == null ? '' : String(o.rightHandSideAttributeValue),
    }
  })
  return { attributes }
}

export function normalizeAccessType(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase()
  return ACCESS_TYPES.has(s) ? s : DEFAULT_ACCESS_TYPE
}

export function specFromItem(item: CanvasItemSnapshot): ProfileSpec {
  const rawTag = item.fields.vlan_tag
  const parsedTag = rawTag === undefined || rawTag === null || rawTag === '' ? null : Number(rawTag)
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    accessType: normalizeAccessType(item.fields.access_type),
    acl: String(item.fields.acl ?? '').trim(),
    daclName: String(item.fields.dacl_name ?? '').trim(),
    vlanName: String(item.fields.vlan_name ?? '').trim(),
    vlanTag: parsedTag != null && Number.isFinite(parsedTag) ? parsedTag : null,
    airespaceAcl: String(item.fields.airespace_acl ?? '').trim(),
    advancedAttributes: parseAdvancedAttributes(item.fields.advanced_attributes).attributes,
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): ProfileSpec[] {
  return items.map(specFromItem)
}

/**
 * The ERS create/update body for a spec. Optional fields are omitted entirely
 * when blank rather than sent as empty strings — ERS treats an omitted field
 * differently from an explicit empty one for several of these (e.g. `vlan` is
 * a nested object, not a string, so it must be absent, not `{}`).
 */
export function toAuthorizationProfileBody(spec: ProfileSpec): Omit<AuthorizationProfile, 'id' | 'link'> {
  const body: Omit<AuthorizationProfile, 'id' | 'link'> = {
    name: spec.name,
    description: spec.description,
    accessType: spec.accessType as 'ACCESS_ACCEPT' | 'ACCESS_REJECT',
    authzProfileType: AUTHZ_PROFILE_TYPE,
  }
  if (spec.acl) body.acl = spec.acl
  if (spec.daclName) body.daclName = spec.daclName
  if (spec.airespaceAcl) body.airespaceACL = spec.airespaceAcl
  if (spec.vlanName) body.vlan = { nameID: spec.vlanName, tagID: spec.vlanTag ?? 1 }
  if (spec.advancedAttributes.length > 0) body.advancedAttributes = spec.advancedAttributes
  return body
}
