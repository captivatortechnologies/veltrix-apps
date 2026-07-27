import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra cross-tenant-access partner-configuration constraints -------------

/** A GUID (the partner tenant id). */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The b2b / trust setting keys a partner configuration may declare. */
export const PARTNER_SETTING_KEYS = new Set([
  'b2bCollaborationInbound',
  'b2bCollaborationOutbound',
  'b2bDirectConnectInbound',
  'b2bDirectConnectOutbound',
  'inboundTrust',
  'automaticUserConsentSettings',
])

export interface CrossTenantPartnerSpec {
  itemId?: string
  /** tenantId — the natural, URL-addressable identity (immutable). */
  tenantId: string
  /** Raw JSON text for the partner configuration (b2b / trust setting objects). */
  configuration: string
}

/** A cross-tenant access partner configuration as returned by Graph. */
export interface LiveCrossTenantPartner {
  tenantId?: string
  [key: string]: unknown
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

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? null))
}

export function extractCrossTenantPartnerSpecs(canvas: CanvasSnapshot): CrossTenantPartnerSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      tenantId: asString(f.tenantId).toLowerCase(),
      configuration: asString(f.configuration),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCrossTenantPartnerSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.tenantId) {
      errors.push({ field: `${prefix}.tenantId`, message: 'Tenant ID is required', code: 'required' })
    } else {
      if (!GUID_RE.test(spec.tenantId)) {
        errors.push({
          field: `${prefix}.tenantId`,
          message: `Tenant ID "${spec.tenantId}" must be a GUID`,
          code: 'invalid_tenant_id',
        })
      }
      if (seen.has(spec.tenantId)) {
        errors.push({
          field: `${prefix}.tenantId`,
          message: `Duplicate partner tenant "${spec.tenantId}" — each may only be declared once per canvas`,
          code: 'duplicate_tenant_id',
        })
      }
      seen.add(spec.tenantId)
    }

    if (spec.configuration) {
      const obj = parseObject(spec.configuration)
      if (!obj) {
        errors.push({
          field: `${prefix}.configuration`,
          message: 'Configuration must be a valid JSON object',
          code: 'invalid_json',
        })
      } else {
        for (const key of Object.keys(obj)) {
          if (!PARTNER_SETTING_KEYS.has(key)) {
            warnings.push({
              field: `${prefix}.configuration`,
              message: `Unrecognized partner setting "${key}" — expected one of ${[...PARTNER_SETTING_KEYS].join(', ')}`,
              code: 'unknown_setting',
            })
          }
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
