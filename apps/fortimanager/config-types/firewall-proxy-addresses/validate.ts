import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager explicit-proxy address constraints -------------------------

export const MAX_NAME_LENGTH = 79
/** v1 covers the common proxy-address types; each has a distinct required field set. */
export const PROXY_ADDRESS_TYPES = ['host-regex', 'url', 'method', 'ua'] as const
export const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'head', 'options', 'trace', 'connect'] as const
export const USER_AGENTS = ['chrome', 'firefox', 'safari', 'ie', 'edge', 'other'] as const

export interface ProxyAddressSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** host-regex | url | method | ua. */
  type: string
  /** References an existing firewall/address name (url, method, ua types). */
  host: string
  /** Regex for the host-regex type. */
  hostRegex: string
  /** URL path regex for the url type. */
  path: string
  /** HTTP methods for the method type. */
  methods: string[]
  /** User agents for the ua type. */
  userAgents: string[]
  comment: string
}

/** A proxy address as returned by a get on the proxy-address table. */
export interface LiveProxyAddress {
  name?: string
  type?: string | number
  host?: string | string[]
  'host-regex'?: string
  path?: string
  method?: string | Array<string | { method?: string }>
  ua?: string | Array<string | { ua?: string }>
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a list value into trimmed, lowercased, de-duplicated tokens. */
export function splitList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.map((t) => t.toLowerCase()).filter((t) => t.length > 0))]
}

/** Normalize a live list of enum tokens (strings or single-key objects). */
export function liveStringList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/[\n,]/).map((t) => t.trim()).filter((t) => t.length > 0)
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (typeof x === 'string') return x.trim()
        if (x && typeof x === 'object') {
          const first = Object.values(x as Record<string, unknown>)[0]
          return typeof first === 'string' ? first.trim() : ''
        }
        return ''
      })
      .filter((t) => t.length > 0)
  }
  return []
}

/** Normalize a scalar that may echo back as a single-element array (e.g. host). */
export function normalizeScalar(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim()
  return ''
}

export function extractProxyAddressSpecs(canvas: CanvasSnapshot): ProxyAddressSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'url').toLowerCase(),
      host: asString(f.host),
      hostRegex: asString(f.hostRegex),
      path: asString(f.path),
      methods: splitList(f.methods),
      userAgents: splitList(f.userAgents),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractProxyAddressSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate proxy address "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(PROXY_ADDRESS_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${PROXY_ADDRESS_TYPES.join(', ')}`, code: 'invalid_type' })
      return
    }

    if (spec.type === 'host-regex') {
      if (!spec.hostRegex) {
        errors.push({ field: `${prefix}.hostRegex`, message: 'A host-regex proxy address needs a host regex', code: 'missing_host_regex' })
      }
    } else if (spec.type === 'url') {
      if (!spec.host) errors.push({ field: `${prefix}.host`, message: 'A url proxy address needs a host address', code: 'missing_host' })
      if (!spec.path) errors.push({ field: `${prefix}.path`, message: 'A url proxy address needs a path', code: 'missing_path' })
    } else if (spec.type === 'method') {
      if (!spec.host) errors.push({ field: `${prefix}.host`, message: 'A method proxy address needs a host address', code: 'missing_host' })
      if (spec.methods.length === 0) {
        errors.push({ field: `${prefix}.methods`, message: 'A method proxy address needs at least one HTTP method', code: 'missing_methods' })
      } else if (!spec.methods.every((m) => (HTTP_METHODS as readonly string[]).includes(m))) {
        errors.push({ field: `${prefix}.methods`, message: `Methods must be from: ${HTTP_METHODS.join(', ')}`, code: 'invalid_method' })
      }
    } else if (spec.type === 'ua') {
      if (!spec.host) errors.push({ field: `${prefix}.host`, message: 'A ua proxy address needs a host address', code: 'missing_host' })
      if (spec.userAgents.length === 0) {
        errors.push({ field: `${prefix}.userAgents`, message: 'A ua proxy address needs at least one user agent', code: 'missing_user_agents' })
      } else if (!spec.userAgents.every((u) => (USER_AGENTS as readonly string[]).includes(u))) {
        errors.push({ field: `${prefix}.userAgents`, message: `User agents must be from: ${USER_AGENTS.join(', ')}`, code: 'invalid_user_agent' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
