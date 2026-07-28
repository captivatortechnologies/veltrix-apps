import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra cross-tenant-access DEFAULT-policy constraints --------------------
//
// The default configuration is a tenant-wide singleton at
// /policies/crossTenantAccessPolicy/default. It always exists and is update-only
// (no create/delete). inboundTrust is freely writable in the default config;
// automaticUserConsentSettings is READ-ONLY here (always false — Graph only lets
// it be set on per-partner configurations), so its checkboxes are advisory.

/** b2b / direct-connect block keys the advanced JSON field may declare. */
export const B2B_SETTING_KEYS = new Set([
  'b2bCollaborationInbound',
  'b2bCollaborationOutbound',
  'b2bDirectConnectInbound',
  'b2bDirectConnectOutbound',
])

/** accessType values Graph accepts inside a crossTenantAccessPolicyB2BSetting. */
export const B2B_ACCESS_TYPES = new Set(['allowed', 'blocked'])

export interface CrossTenantDefaultSpec {
  itemId?: string
  inboundTrustMfa: boolean
  inboundTrustCompliantDevice: boolean
  inboundTrustHybridJoined: boolean
  /** Advisory — read-only on the default policy (see file header). */
  autoConsentInbound: boolean
  /** Advisory — read-only on the default policy (see file header). */
  autoConsentOutbound: boolean
  /** Raw JSON text for the full b2bCollaboration/DirectConnect blocks, or ''. */
  b2bCollaboration: string
}

/** The cross-tenant access default policy singleton as returned by Graph. */
export interface LiveCrossTenantDefault {
  isServiceDefault?: boolean
  inboundTrust?: {
    isMfaAccepted?: boolean
    isCompliantDeviceAccepted?: boolean
    isHybridAzureADJoinedDeviceAccepted?: boolean
  } | null
  automaticUserConsentSettings?: {
    inboundAllowed?: boolean | null
    outboundAllowed?: boolean | null
  } | null
  [key: string]: unknown
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a JSON string into a plain object, or null when it isn't a JSON object. */
export function parseObject(text: string): Record<string, unknown> | null {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Recursively sort object keys so equal objects stringify identically. */
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** Canonical form of a value for key-order-insensitive comparison. */
export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? null))
}

export function extractCrossTenantDefaultSpecs(canvas: CanvasSnapshot): CrossTenantDefaultSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      inboundTrustMfa: asBool(f.inboundTrustMfa),
      inboundTrustCompliantDevice: asBool(f.inboundTrustCompliantDevice),
      inboundTrustHybridJoined: asBool(f.inboundTrustHybridJoined),
      autoConsentInbound: asBool(f.autoConsentInbound),
      autoConsentOutbound: asBool(f.autoConsentOutbound),
      b2bCollaboration: asString(f.b2bCollaboration),
    }
  })
}

/** True when the spec asks for no meaningful change at all. */
function isEmpty(spec: CrossTenantDefaultSpec): boolean {
  return (
    !spec.inboundTrustMfa &&
    !spec.inboundTrustCompliantDevice &&
    !spec.inboundTrustHybridJoined &&
    !spec.autoConsentInbound &&
    !spec.autoConsentOutbound &&
    !spec.b2bCollaboration
  )
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCrossTenantDefaultSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'items',
      message: 'The cross-tenant access default policy is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (isEmpty(spec)) {
      warnings.push({
        field: prefix,
        message: 'No fields set — this policy would leave the default cross-tenant configuration unchanged',
        code: 'no_effective_change',
      })
    }

    if (spec.autoConsentInbound || spec.autoConsentOutbound) {
      warnings.push({
        field: `${prefix}.autoConsent`,
        message:
          'automaticUserConsentSettings is read-only on the default policy (Graph keeps it false) — ' +
          'automatic user consent is configurable only on per-partner cross-tenant configurations',
        code: 'auto_consent_readonly',
      })
    }

    if (spec.b2bCollaboration) {
      const obj = parseObject(spec.b2bCollaboration)
      if (!obj) {
        errors.push({
          field: `${prefix}.b2bCollaboration`,
          message: 'B2B collaboration settings must be a valid JSON object',
          code: 'invalid_json',
        })
      } else {
        for (const key of Object.keys(obj)) {
          if (!B2B_SETTING_KEYS.has(key)) {
            warnings.push({
              field: `${prefix}.b2bCollaboration`,
              message: `Unrecognized block "${key}" — expected one of ${[...B2B_SETTING_KEYS].join(', ')}`,
              code: 'unknown_block',
            })
            continue
          }
          const block = obj[key]
          if (block && typeof block === 'object' && !Array.isArray(block)) {
            for (const side of ['usersAndGroups', 'applications'] as const) {
              const cfg = (block as Record<string, unknown>)[side]
              const accessType =
                cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).accessType : undefined
              if (typeof accessType === 'string' && !B2B_ACCESS_TYPES.has(accessType)) {
                warnings.push({
                  field: `${prefix}.b2bCollaboration`,
                  message: `${key}.${side}.accessType "${accessType}" should be "allowed" or "blocked"`,
                  code: 'invalid_access_type',
                })
              }
            }
          }
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
