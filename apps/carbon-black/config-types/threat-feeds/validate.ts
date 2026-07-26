import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black threat feed constraints ------------------------------------

/** IOC fields this config type supports for the managed report. */
export const IOC_FIELDS = ['process_hash', 'netconn_domain', 'netconn_ipv4'] as const

export interface FeedSpec {
  itemId?: string
  /** name — the feed's human identity (feeds are id-addressed; matched by name). */
  name: string
  providerUrl: string
  summary: string
  category: string
  /** the UDM field the IOC values match on. */
  iocField: string
  /** the IOC values (hashes / domains / ips). */
  values: string[]
}

/** A feed as returned by the feed manager. */
export interface LiveFeed {
  id?: string
  name?: string
  provider_url?: string
  summary?: string
  category?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitValues(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractFeedSpecs(canvas: CanvasSnapshot): FeedSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      providerUrl: asString(f.providerUrl),
      summary: asString(f.summary),
      category: asString(f.category) || 'external_threat_intel',
      iocField: (asString(f.iocField) || 'process_hash').toLowerCase(),
      values: splitValues(f.values),
    }
  })
}

const SHA256_RE = /^[a-fA-F0-9]{64}$/

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFeedSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate feed "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.providerUrl) errors.push({ field: `${prefix}.providerUrl`, message: 'Provider URL is required', code: 'required' })
    if (!spec.summary) errors.push({ field: `${prefix}.summary`, message: 'Summary is required', code: 'required' })

    if (!(IOC_FIELDS as readonly string[]).includes(spec.iocField)) {
      errors.push({ field: `${prefix}.iocField`, message: `IOC field must be one of: ${IOC_FIELDS.join(', ')}`, code: 'invalid_ioc_field' })
    }

    if (spec.iocField === 'process_hash') {
      spec.values.forEach((v, vi) => {
        if (!SHA256_RE.test(v)) errors.push({ field: `${prefix}.values[${vi}]`, message: `"${v}" is not a valid SHA256 hash`, code: 'invalid_hash' })
      })
    }

    if (spec.values.length === 0) {
      warnings.push({ field: `${prefix}.values`, message: 'This feed has no IOC values', code: 'empty_feed' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
