import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager DNS filter profile constraints -----------------------------
// Bounded scope: the top-level scalar fields are first-class; the complex nested
// body (ftgd-dns category filters, domain-filter, external-ip-blocklist) is
// supplied as one validated-JSON object.

export const MAX_NAME_LENGTH = 79
export const BLOCK_ACTIONS = ['block', 'redirect', 'block-sevrfail'] as const

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

export interface DnsFilterProfileSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  /** block | redirect | block-sevrfail. */
  blockAction: string
  blockBotnet: boolean
  logAllDomain: boolean
  safeSearch: boolean
  /** IP a blocked domain is redirected to (only meaningful for the redirect action). */
  redirectPortal: string
  sdnsFtgdErrLog: boolean
  sdnsDomainLog: boolean
  /** Raw JSON for the nested body (e.g. ftgd-dns). Validated to parse to an object. */
  bodyJson: string
}

/** A DNS filter profile as returned by a get on the dnsfilter/profile table. */
export interface LiveDnsFilterProfile {
  name?: string
  comment?: string
  'block-action'?: string | number
  'block-botnet'?: string | number
  'log-all-domain'?: string | number
  'safe-search'?: string | number
  'redirect-portal'?: string
  'sdns-ftgd-err-log'?: string | number
  'sdns-domain-log'?: string | number
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

export function extractDnsFilterProfileSpecs(canvas: CanvasSnapshot): DnsFilterProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      blockAction: (asString(f.blockAction) || 'redirect').toLowerCase(),
      blockBotnet: asBool(f.blockBotnet),
      logAllDomain: asBool(f.logAllDomain),
      safeSearch: asBool(f.safeSearch),
      redirectPortal: asString(f.redirectPortal),
      sdnsFtgdErrLog: asBool(f.sdnsFtgdErrLog),
      sdnsDomainLog: asBool(f.sdnsDomainLog),
      bodyJson: typeof f.bodyJson === 'string' ? f.bodyJson : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDnsFilterProfileSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate DNS filter profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(BLOCK_ACTIONS as readonly string[]).includes(spec.blockAction)) {
      errors.push({ field: `${prefix}.blockAction`, message: `Block action must be one of: ${BLOCK_ACTIONS.join(', ')}`, code: 'invalid_block_action' })
    }

    if (spec.redirectPortal && !isValidIpv4(spec.redirectPortal)) {
      errors.push({ field: `${prefix}.redirectPortal`, message: 'Redirect portal must be a valid IPv4 address', code: 'invalid_ip' })
    }

    if (!parseBodyJson(spec.bodyJson).ok) {
      errors.push({ field: `${prefix}.bodyJson`, message: 'Advanced body must be valid JSON describing an object (e.g. {"ftgd-dns": {...}})', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
