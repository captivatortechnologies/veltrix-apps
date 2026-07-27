import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager SSL/SSH inspection profile constraints ---------------------
// Bounded scope: the top-level scalar fields are first-class; the per-protocol
// inspection dicts (ssl, https, ftps, imaps, pop3s, smtps, ssh, dot) are supplied
// as one validated-JSON object.

export const MAX_NAME_LENGTH = 79
export const SERVER_CERT_MODES = ['re-sign', 'replace'] as const

export interface SslSshProfileSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  allowlist: boolean
  blockBlocklistedCertificates: boolean
  sslAnomaliesLog: boolean
  sslExemptionsLog: boolean
  useSslServer: boolean
  /** re-sign | replace. */
  serverCertMode: string
  untrustedCaname: string
  /** Raw JSON for the per-protocol body (ssl, https, …). Validated to parse to an object. */
  bodyJson: string
}

/** An SSL/SSH profile as returned by a get on the firewall/ssl-ssh-profile table. */
export interface LiveSslSshProfile {
  name?: string
  comment?: string
  allowlist?: string | number
  'block-blocklisted-certificates'?: string | number
  'ssl-anomalies-log'?: string | number
  'ssl-exemptions-log'?: string | number
  'use-ssl-server'?: string | number
  'server-cert-mode'?: string | number
  'untrusted-caname'?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'enable' || v === 1
}

export function parseBodyJson(raw: string): { ok: boolean; value: Record<string, unknown> } {
  if (!raw.trim()) return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
    return { ok: false, value: {} }
  } catch {
    return { ok: false, value: {} }
  }
}

export function extractSslSshProfileSpecs(canvas: CanvasSnapshot): SslSshProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      allowlist: asBool(f.allowlist),
      blockBlocklistedCertificates: asBool(f.blockBlocklistedCertificates),
      sslAnomaliesLog: asBool(f.sslAnomaliesLog),
      sslExemptionsLog: asBool(f.sslExemptionsLog),
      useSslServer: asBool(f.useSslServer),
      serverCertMode: (asString(f.serverCertMode) || 're-sign').toLowerCase(),
      untrustedCaname: asString(f.untrustedCaname),
      bodyJson: typeof f.bodyJson === 'string' ? f.bodyJson : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSslSshProfileSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate SSL/SSH profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(SERVER_CERT_MODES as readonly string[]).includes(spec.serverCertMode)) {
      errors.push({ field: `${prefix}.serverCertMode`, message: `Server certificate mode must be one of: ${SERVER_CERT_MODES.join(', ')}`, code: 'invalid_server_cert_mode' })
    }

    if (!parseBodyJson(spec.bodyJson).ok) {
      errors.push({ field: `${prefix}.bodyJson`, message: 'Advanced body must be valid JSON describing an object (e.g. {"https": {"status": "deep-inspection"}})', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
