import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager user LDAP auth server constraints --------------------------

export const MAX_NAME_LENGTH = 79
export const LDAP_TYPES = ['simple', 'anonymous', 'regular'] as const
export const LDAP_SECURE = ['disable', 'starttls', 'ldaps'] as const
export const LDAP_GROUP_MEMBER_CHECK = ['user-attr', 'group-object', 'posix-group-object'] as const

export interface LdapServerSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** Primary LDAP server (IP or FQDN). */
  server: string
  secondaryServer: string
  cnid: string
  /** Distinguished name used to look up entries. */
  dn: string
  /** simple | anonymous | regular. */
  type: string
  /** Bind DN — required for the regular bind type. */
  username: string
  /** Bind password — write-only, always re-sent, never read back or diffed. */
  password: string
  /** LDAP port; blank means the FortiManager default (389 / 636). */
  port: string
  /** disable | starttls | ldaps. */
  secure: string
  groupMemberCheck: string
  groupSearchBase: string
}

/** An LDAP server as returned by a get on the user/ldap table. The `password`
 *  field is never present — FortiManager does not return secrets. */
export interface LiveLdapServer {
  name?: string
  server?: string
  'secondary-server'?: string
  cnid?: string
  dn?: string
  type?: string | number
  username?: string
  port?: string | number
  secure?: string | number
  'group-member-check'?: string | number
  'group-search-base'?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

export function extractLdapServerSpecs(canvas: CanvasSnapshot): LdapServerSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      server: asString(f.server),
      secondaryServer: asString(f.secondaryServer),
      cnid: asString(f.cnid) || 'cn',
      dn: asString(f.dn),
      type: (asString(f.type) || 'simple').toLowerCase(),
      username: asString(f.username),
      password: typeof f.password === 'string' ? f.password : '',
      port: asString(f.port),
      secure: (asString(f.secure) || 'disable').toLowerCase(),
      groupMemberCheck: asString(f.groupMemberCheck).toLowerCase(),
      groupSearchBase: asString(f.groupSearchBase),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLdapServerSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate LDAP server "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.server) {
      errors.push({ field: `${prefix}.server`, message: 'An LDAP server address (IP or FQDN) is required', code: 'required' })
    }

    if (!(LDAP_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${LDAP_TYPES.join(', ')}`, code: 'invalid_type' })
    } else if (spec.type === 'regular' && !spec.username) {
      errors.push({ field: `${prefix}.username`, message: 'A regular bind needs a bind DN (username)', code: 'missing_bind_dn' })
    }

    if (!(LDAP_SECURE as readonly string[]).includes(spec.secure)) {
      errors.push({ field: `${prefix}.secure`, message: `Secure must be one of: ${LDAP_SECURE.join(', ')}`, code: 'invalid_secure' })
    }

    if (spec.groupMemberCheck && !(LDAP_GROUP_MEMBER_CHECK as readonly string[]).includes(spec.groupMemberCheck)) {
      errors.push({ field: `${prefix}.groupMemberCheck`, message: `Group member check must be one of: ${LDAP_GROUP_MEMBER_CHECK.join(', ')}`, code: 'invalid_group_member_check' })
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
