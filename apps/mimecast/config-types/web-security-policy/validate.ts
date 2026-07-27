import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast Web Security (SWG) block/allow policy constraints ---------------

export const URL_ACTIONS = ['block', 'allow'] as const
export const URL_TYPES = ['domain', 'url'] as const
export const TARGET_TYPES = ['everyone', 'email_domain', 'individual_email_address'] as const

export interface WebUrl {
  /** block | allow. */
  action: string
  /** domain | url. */
  type: string
  value: string
}

export interface WebSecurityPolicySpec {
  itemId?: string
  /** description — the policy identity (policies are id-addressed). */
  description: string
  enabled: boolean
  fromType: string
  fromValue: string
  toType: string
  toValue: string
  urls: WebUrl[]
}

/** A web security policy as returned by get-policies. */
export interface LiveWebPolicy {
  id?: string
  description?: string
  urls?: Array<{ id?: string; action?: string; type?: string; value?: string }>
  policies?: Array<{
    id?: string
    policy?: {
      description?: string
      enabled?: boolean
      from?: { type?: string; emailAddress?: string; emailDomain?: string; groupId?: string }
      to?: { type?: string; emailAddress?: string; emailDomain?: string; groupId?: string }
    }
  }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the URL textarea — each non-empty line is "<action> <type> <value>". */
export function parseUrls(raw: unknown): Array<WebUrl & { raw: string }> {
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : ''
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/)
      return {
        raw: line,
        action: (parts[0] ?? '').toLowerCase(),
        type: (parts[1] ?? '').toLowerCase(),
        value: parts.slice(2).join(' '),
      }
    })
}

export function extractWebSecurityPolicySpecs(canvas: CanvasSnapshot): WebSecurityPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
      fromType: (asString(f.fromType) || 'everyone').toLowerCase(),
      fromValue: asString(f.fromValue),
      toType: (asString(f.toType) || 'everyone').toLowerCase(),
      toValue: asString(f.toValue),
      urls: parseUrls(f.urls).map(({ action, type, value }) => ({ action, type, value })),
    }
  })
}

/** The identity of a URL entry within a policy. */
export function urlIdentity(u: WebUrl): string {
  return `${u.action}:${u.type}:${u.value.toLowerCase()}`
}

function validateTarget(type: string, value: string, side: string, prefix: string, errors: ValidationResult['errors']): void {
  if (!(TARGET_TYPES as readonly string[]).includes(type)) {
    errors.push({ field: `${prefix}.${side}Type`, message: `${side} type must be one of: ${TARGET_TYPES.join(', ')}`, code: 'invalid_target_type' })
    return
  }
  if ((type === 'email_domain' || type === 'individual_email_address') && !value) {
    errors.push({ field: `${prefix}.${side}Value`, message: `${side} needs a ${type === 'email_domain' ? 'domain' : 'email address'}`, code: 'missing_value' })
  }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractWebSecurityPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the policy identity)', code: 'required' })
    } else {
      const key = spec.description.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.description`, message: `Duplicate policy "${spec.description}"`, code: 'duplicate_description' })
      }
      seen.add(key)
    }

    validateTarget(spec.fromType, spec.fromValue, 'from', prefix, errors)
    validateTarget(spec.toType, spec.toValue, 'to', prefix, errors)

    if (spec.urls.length === 0) {
      errors.push({ field: `${prefix}.urls`, message: 'At least one URL entry is required', code: 'required' })
    }
    const seenUrls = new Set<string>()
    spec.urls.forEach((u, ui) => {
      if (!u.value) {
        errors.push({ field: `${prefix}.urls[${ui}]`, message: 'Each URL line must be "<action> <type> <value>"', code: 'invalid_url_line' })
        return
      }
      if (!(URL_ACTIONS as readonly string[]).includes(u.action)) {
        errors.push({ field: `${prefix}.urls[${ui}].action`, message: `URL action must be one of: ${URL_ACTIONS.join(', ')}`, code: 'invalid_url_action' })
      }
      if (!(URL_TYPES as readonly string[]).includes(u.type)) {
        errors.push({ field: `${prefix}.urls[${ui}].type`, message: `URL type must be one of: ${URL_TYPES.join(', ')}`, code: 'invalid_url_type' })
      }
      const id = urlIdentity(u)
      if (seenUrls.has(id)) {
        errors.push({ field: `${prefix}.urls[${ui}]`, message: `Duplicate URL entry "${u.value}"`, code: 'duplicate_url' })
      }
      seenUrls.add(id)
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
