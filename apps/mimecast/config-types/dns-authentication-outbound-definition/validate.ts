import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast DNS Authentication - Outbound (DKIM) definition constraints ---
// (Policy Management v1)

export const KEY_LENGTHS = [1024, 2048] as const
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const MAX_SELECTOR_LENGTH = 256

export interface DnsAuthOutboundDefinitionSpec {
  itemId?: string
  /** description — the definition identity. */
  description: string
  domain: string
  /** optional — Mimecast generates one when omitted. */
  selector: string
  signDkim: boolean
  keyLength: number
}

/**
 * A DNS Authentication - Outbound definition as returned by the v1 API. The
 * DKIM private key is never part of this shape — Mimecast holds it internally
 * and only exposes the public DNS record content, which this config type does
 * not need to read to manage the definition declaratively.
 */
export interface LiveDnsAuthOutboundDefinition {
  id?: string
  description?: string
  domain?: string
  selector?: string
  signDkim?: boolean
  keyLength?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function asKeyLength(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 2048
}

export function extractDnsAuthOutboundDefinitionSpecs(canvas: CanvasSnapshot): DnsAuthOutboundDefinitionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      domain: asString(f.domain).toLowerCase(),
      selector: asString(f.selector),
      signDkim: typeof f.signDkim === 'boolean' ? f.signDkim : asBool(f.signDkim ?? true),
      keyLength: asKeyLength(f.keyLength),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDnsAuthOutboundDefinitionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the definition identity)', code: 'required' })
    } else {
      const key = spec.description.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.description`, message: `Duplicate definition "${spec.description}"`, code: 'duplicate_description' })
      }
      seen.add(key)
    }

    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Domain is required', code: 'required' })
    } else if (!DOMAIN_RE.test(spec.domain)) {
      errors.push({ field: `${prefix}.domain`, message: `"${spec.domain}" is not a valid domain`, code: 'invalid_domain' })
    }

    if (spec.selector && spec.selector.length > MAX_SELECTOR_LENGTH) {
      errors.push({ field: `${prefix}.selector`, message: `Selector must be at most ${MAX_SELECTOR_LENGTH} characters`, code: 'invalid_selector' })
    }

    if (!(KEY_LENGTHS as readonly number[]).includes(spec.keyLength)) {
      errors.push({ field: `${prefix}.keyLength`, message: `Key length must be one of: ${KEY_LENGTHS.join(', ')}`, code: 'invalid_key_length' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
