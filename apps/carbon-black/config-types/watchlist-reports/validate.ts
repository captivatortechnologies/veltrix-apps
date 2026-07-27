import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black watchlist (shared) report constraints ----------------------

/** Equality-IOC fields a watchlist report can match on. */
export const REPORT_IOC_FIELDS = ['process_hash', 'netconn_domain', 'netconn_ipv4'] as const

export const MIN_SEVERITY = 1
export const MAX_SEVERITY = 10

export interface ReportSpec {
  itemId?: string
  /** title — the report's identity within the org's shared reports store. */
  title: string
  description: string
  severity: number
  /** the equality IOC field the values match on. */
  iocField: string
  /** the IOC values (hashes / domains / ips). */
  values: string[]
  link: string
  tags: string[]
}

/** A shared report as returned by the watchlist manager. */
export interface LiveReport {
  id?: string
  title?: string
  description?: string
  severity?: number
  timestamp?: number
  link?: string
  tags?: string[]
  iocs_v2?: Array<{ id?: string; match_type?: string; field?: string; values?: string[] }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

export function splitValues(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractReportSpecs(canvas: CanvasSnapshot): ReportSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      title: asString(f.title) || item.name,
      description: asString(f.description),
      severity: asNumber(f.severity, 5),
      iocField: (asString(f.iocField) || 'process_hash').toLowerCase(),
      values: splitValues(f.values),
      link: asString(f.link),
      tags: splitValues(f.tags),
    }
  })
}

const SHA256_RE = /^[a-fA-F0-9]{64}$/

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractReportSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Title is required', code: 'required' })
    } else {
      const key = spec.title.toLowerCase()
      if (seen.has(key)) errors.push({ field: `${prefix}.title`, message: `Duplicate report "${spec.title}"`, code: 'duplicate_title' })
      seen.add(key)
    }

    if (!spec.description) errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })

    if (!Number.isInteger(spec.severity) || spec.severity < MIN_SEVERITY || spec.severity > MAX_SEVERITY) {
      errors.push({ field: `${prefix}.severity`, message: `Severity must be an integer from ${MIN_SEVERITY} to ${MAX_SEVERITY}`, code: 'invalid_severity' })
    }

    if (!(REPORT_IOC_FIELDS as readonly string[]).includes(spec.iocField)) {
      errors.push({ field: `${prefix}.iocField`, message: `IOC field must be one of: ${REPORT_IOC_FIELDS.join(', ')}`, code: 'invalid_ioc_field' })
    }

    // A report must carry at least one IOC — the API rejects an empty report.
    if (spec.values.length === 0) {
      errors.push({ field: `${prefix}.values`, message: 'A report must have at least one IOC value', code: 'required' })
    } else if (spec.iocField === 'process_hash') {
      spec.values.forEach((v, vi) => {
        if (!SHA256_RE.test(v)) errors.push({ field: `${prefix}.values[${vi}]`, message: `"${v}" is not a valid SHA256 hash`, code: 'invalid_hash' })
      })
    }

    // Setting a link makes the report non-editable in the console (API PUT still works).
    if (spec.link) {
      warnings.push({ field: `${prefix}.link`, message: 'Setting a link makes this report non-editable in the CBC console (API updates still work)', code: 'console_noneditable' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
