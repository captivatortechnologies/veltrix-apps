import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager user FSSO collector-agent constraints ----------------------

export const MAX_NAME_LENGTH = 79
export const FSSO_TYPES = ['default', 'fortinac'] as const

export interface FssoAgentSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** Primary FSSO collector agent host (IP or FQDN). */
  server: string
  port: string
  /** Primary agent password — write-only, always re-sent, never read back or diffed. */
  password: string
  server2: string
  server3: string
  server4: string
  /** default | fortinac. */
  type: string
  /** References a user/ldap server name for group lookups. */
  ldapServer: string
}

/** An FSSO agent as returned by a get on the user/fsso table. The `password`
 *  field is never present — FortiManager does not return secrets. */
export interface LiveFssoAgent {
  name?: string
  server?: string
  port?: string | number
  server2?: string
  server3?: string
  server4?: string
  type?: string | number
  'ldap-server'?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

export function extractFssoAgentSpecs(canvas: CanvasSnapshot): FssoAgentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      server: asString(f.server),
      port: asString(f.port),
      password: typeof f.password === 'string' ? f.password : '',
      server2: asString(f.server2),
      server3: asString(f.server3),
      server4: asString(f.server4),
      type: (asString(f.type) || 'default').toLowerCase(),
      ldapServer: asString(f.ldapServer),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFssoAgentSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate FSSO agent "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.server) {
      errors.push({ field: `${prefix}.server`, message: 'A primary collector-agent host (IP or FQDN) is required', code: 'required' })
    }

    if (!(FSSO_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${FSSO_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (spec.port) {
      const n = Number(spec.port)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        errors.push({ field: `${prefix}.port`, message: 'Port must be an integer between 1 and 65535', code: 'invalid_port' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
