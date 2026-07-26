import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast managed URL constraints ----------------------------------------

export const ACTIONS = ['block', 'permit'] as const
export const MATCH_TYPES = ['explicit', 'domain'] as const

export interface ManagedUrlSpec {
  itemId?: string
  url: string
  /** block | permit. */
  action: string
  /** explicit (whole URL) | domain. */
  matchType: string
  comment: string
  disableRewrite: boolean
  disableUserAwareness: boolean
  disableLogClick: boolean
}

/** A managed URL as returned by get-all-managed-urls. */
export interface LiveManagedUrl {
  id?: string
  url?: string
  scheme?: string
  domain?: string
  port?: number
  path?: string
  queryString?: string
  matchType?: string
  action?: string
  comment?: string
  disableRewrite?: boolean
  disableUserAwareness?: boolean
  disableLogClick?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractManagedUrlSpecs(canvas: CanvasSnapshot): ManagedUrlSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      url: asString(f.url),
      action: (asString(f.action) || 'block').toLowerCase(),
      matchType: (asString(f.matchType) || 'explicit').toLowerCase(),
      comment: asString(f.comment),
      disableRewrite: asBool(f.disableRewrite),
      disableUserAwareness: asBool(f.disableUserAwareness),
      disableLogClick: asBool(f.disableLogClick),
    }
  })
}

/** Extract the host from a URL or bare-domain string. */
export function hostOf(url: string): string {
  const s = url.trim().replace(/^[a-z]+:\/\//i, '')
  return s.split(/[/:?#]/)[0].toLowerCase()
}

/** Normalize a full URL for comparison (scheme forced, fragment + trailing slash stripped). */
export function normUrl(url: string): string {
  let s = url.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
  if (s && !/^[a-z]+:\/\//.test(s)) s = `https://${s}`
  return s
}

/** The identity a desired managed URL is matched on. */
export function desiredIdentity(spec: ManagedUrlSpec): string {
  return spec.matchType === 'domain' ? `domain:${hostOf(spec.url)}` : `explicit:${normUrl(spec.url)}`
}

/** The identity of a live managed URL (mirrors desiredIdentity). */
export function liveIdentity(entry: LiveManagedUrl): string {
  const matchType = (entry.matchType ?? 'explicit').toLowerCase()
  if (matchType === 'domain') return `domain:${(entry.domain ?? '').toLowerCase()}`
  if (entry.url) return `explicit:${normUrl(entry.url)}`
  const scheme = entry.scheme || 'https'
  const port = entry.port && entry.port !== -1 ? `:${entry.port}` : ''
  const qs = entry.queryString ? `?${entry.queryString}` : ''
  return `explicit:${normUrl(`${scheme}://${entry.domain ?? ''}${port}${entry.path ?? ''}${qs}`)}`
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractManagedUrlSpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.url) {
      errors.push({ field: `${prefix}.url`, message: 'URL is required', code: 'required' })
    } else if (spec.url.includes('#')) {
      errors.push({ field: `${prefix}.url`, message: 'URL must not contain a fragment (#)', code: 'has_fragment' })
    }

    if (!(ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({ field: `${prefix}.action`, message: `Action must be one of: ${ACTIONS.join(', ')}`, code: 'invalid_action' })
    }
    if (!(MATCH_TYPES as readonly string[]).includes(spec.matchType)) {
      errors.push({ field: `${prefix}.matchType`, message: `Match type must be one of: ${MATCH_TYPES.join(', ')}`, code: 'invalid_match_type' })
    }

    if (spec.url) {
      const key = desiredIdentity(spec)
      if (seenKeys.has(key)) {
        errors.push({ field: `${prefix}.url`, message: `Duplicate managed URL — another item already targets ${key}`, code: 'duplicate_url' })
      }
      seenKeys.add(key)
    }

    if ((spec.disableRewrite || spec.disableUserAwareness) && spec.action !== 'permit') {
      warnings.push({ field: `${prefix}`, message: 'disableRewrite / disableUserAwareness only apply to a permit action', code: 'ignored_flags' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
