import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager user RADIUS auth server constraints ------------------------

export const MAX_NAME_LENGTH = 79
export const RADIUS_AUTH_TYPES = ['auto', 'ms_chap_v2', 'ms_chap', 'chap', 'pap'] as const

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

export interface RadiusServerSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** Primary RADIUS server (IP or FQDN). */
  server: string
  /** Shared secret — write-only, always re-sent, never read back or diffed. */
  secret: string
  secondaryServer: string
  /** Secondary shared secret — write-only. */
  secondarySecret: string
  /** auto | ms_chap_v2 | ms_chap | chap | pap. */
  authType: string
  nasIp: string
  radiusPort: string
  timeout: string
}

/** A RADIUS server as returned by a get on the user/radius table. Secrets are
 *  never present — FortiManager does not return them. */
export interface LiveRadiusServer {
  name?: string
  server?: string
  'secondary-server'?: string
  'auth-type'?: string | number
  'nas-ip'?: string
  'radius-port'?: string | number
  timeout?: string | number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

export function extractRadiusServerSpecs(canvas: CanvasSnapshot): RadiusServerSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      server: asString(f.server),
      secret: typeof f.secret === 'string' ? f.secret : '',
      secondaryServer: asString(f.secondaryServer),
      secondarySecret: typeof f.secondarySecret === 'string' ? f.secondarySecret : '',
      authType: (asString(f.authType) || 'auto').toLowerCase(),
      nasIp: asString(f.nasIp),
      radiusPort: asString(f.radiusPort),
      timeout: asString(f.timeout),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRadiusServerSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate RADIUS server "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.server) {
      errors.push({ field: `${prefix}.server`, message: 'A RADIUS server address (IP or FQDN) is required', code: 'required' })
    }
    if (!spec.secret) {
      errors.push({ field: `${prefix}.secret`, message: 'A shared secret is required', code: 'required' })
    }

    if (!(RADIUS_AUTH_TYPES as readonly string[]).includes(spec.authType)) {
      errors.push({ field: `${prefix}.authType`, message: `Auth type must be one of: ${RADIUS_AUTH_TYPES.join(', ')}`, code: 'invalid_auth_type' })
    }

    if (spec.nasIp && !isValidIpv4(spec.nasIp)) {
      errors.push({ field: `${prefix}.nasIp`, message: 'NAS IP must be a valid IPv4 address', code: 'invalid_ip' })
    }

    if (spec.radiusPort) {
      const n = Number(spec.radiusPort)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        errors.push({ field: `${prefix}.radiusPort`, message: 'Port must be an integer between 1 and 65535', code: 'invalid_port' })
      }
    }
    if (spec.timeout) {
      const n = Number(spec.timeout)
      if (!Number.isInteger(n) || n < 1) {
        errors.push({ field: `${prefix}.timeout`, message: 'Timeout must be a positive integer (seconds)', code: 'invalid_timeout' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
