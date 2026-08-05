import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra security-group constraints ----------------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_DESCRIPTION_LENGTH = 1024
export const MAX_MAIL_NICKNAME_LENGTH = 64
/** mailNickname: letters, digits and a small punctuation set; no spaces. */
const MAIL_NICKNAME_RE = /^[A-Za-z0-9._-]+$/

export interface GroupSpec {
  itemId?: string
  /** displayName — the logical identity live groups are matched on. */
  name: string
  description: string
  /** Explicit mailNickname, or '' to derive one from the name. */
  mailNickname: string
  /** Owner object ids, UPNs or display names (users or service principals) — resolved at deploy time. */
  owners: string[]
  /** Member object ids, UPNs or display names (users, groups, devices or service principals) — resolved at deploy time. */
  members: string[]
}

/** A group as returned by Graph GET /groups. */
export interface LiveGroup {
  id?: string
  displayName?: string
  description?: string | null
  mailNickname?: string | null
  mailEnabled?: boolean
  securityEnabled?: boolean
  groupTypes?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Coerce a multiselect (array) or a delimited string into trimmed tokens. */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Derive a valid mailNickname from a display name (letters/digits/._- only). */
export function slugifyNickname(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MAIL_NICKNAME_LENGTH)
}

/** The effective mailNickname for a spec: explicit value, else derived. */
export function effectiveNickname(spec: GroupSpec): string {
  return spec.mailNickname || slugifyNickname(spec.name)
}

/**
 * Only plain assigned security groups are safe to manage: not mail-enabled, not
 * a Microsoft 365 (Unified) group, and not a dynamic-membership group. This
 * protects built-in and other-purpose groups that happen to share a name.
 */
export function isManageableSecurityGroup(live: LiveGroup): boolean {
  if (live.mailEnabled === true) return false
  const types = live.groupTypes ?? []
  if (types.includes('Unified') || types.includes('DynamicMembership')) return false
  return live.securityEnabled !== false
}

export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      mailNickname: asString(f.mailNickname),
      owners: asStringArray(f.owners),
      members: asStringArray(f.members),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // displayName — required, length, uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // description — length only
    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    // mailNickname — explicit value must be valid; a blank one is derived, but
    // the derived value must be non-empty (e.g. an all-symbol name can't slug).
    const nick = effectiveNickname(spec)
    if (spec.mailNickname) {
      if (spec.mailNickname.length > MAX_MAIL_NICKNAME_LENGTH) {
        errors.push({
          field: `${prefix}.mailNickname`,
          message: `Mail nickname must be ${MAX_MAIL_NICKNAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      if (!MAIL_NICKNAME_RE.test(spec.mailNickname)) {
        errors.push({
          field: `${prefix}.mailNickname`,
          message: 'Mail nickname may contain only letters, digits and . _ - (no spaces)',
          code: 'invalid_mail_nickname',
        })
      }
    } else if (spec.name && !nick) {
      errors.push({
        field: `${prefix}.mailNickname`,
        message: `Could not derive a mail nickname from "${spec.name}" — set one explicitly`,
        code: 'invalid_mail_nickname',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
