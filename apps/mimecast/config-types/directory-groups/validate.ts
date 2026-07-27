import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast directory profile group constraints ----------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

export interface DirectoryGroupSpec {
  itemId?: string
  /** description — the group name (its identity, under parentId). */
  description: string
  /** optional secure id of the parent group (root when omitted). */
  parentId: string
  /** members — email addresses (contain "@") and/or domains. */
  members: string[]
}

/** A group as returned by find-groups. */
export interface LiveGroup {
  id?: string
  description?: string
  parentId?: string
  source?: string
  userCount?: number
  folderCount?: number
  folders?: LiveGroup[]
}

/** A member as returned by get-group-members. */
export interface LiveMember {
  emailAddress?: string
  domain?: string
  internal?: boolean
  name?: string
  type?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
  if (typeof v === 'string') return v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  return []
}

export function extractDirectoryGroupSpecs(canvas: CanvasSnapshot): DirectoryGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      parentId: asString(f.parentId),
      members: asStringList(f.members),
    }
  })
}

/** The identity a group is matched on (name, scoped by parent when given). */
export function groupKey(spec: { description: string; parentId: string }): string {
  return spec.parentId ? `${spec.description.toLowerCase()}|${spec.parentId}` : spec.description.toLowerCase()
}

/** Whether a raw member string denotes an email address (vs a domain). */
export function isEmailMember(raw: string): boolean {
  return raw.includes('@')
}

/** The identity of a declared member (email:<lower> | domain:<lower>). */
export function memberIdentity(raw: string): string {
  return isEmailMember(raw) ? `email:${raw.toLowerCase()}` : `domain:${raw.toLowerCase()}`
}

/** The identity of a live member (mirrors memberIdentity). */
export function liveMemberIdentity(m: LiveMember): string {
  if (m.emailAddress) return `email:${m.emailAddress.toLowerCase()}`
  return `domain:${(m.domain ?? '').toLowerCase()}`
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDirectoryGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the group identity)', code: 'required' })
    } else {
      const key = groupKey(spec)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.description`, message: `Duplicate group "${spec.description}" under the same parent`, code: 'duplicate_description' })
      }
      seen.add(key)
    }

    const seenMembers = new Set<string>()
    spec.members.forEach((raw, mi) => {
      const valid = isEmailMember(raw) ? EMAIL_RE.test(raw) : DOMAIN_RE.test(raw)
      if (!valid) {
        errors.push({ field: `${prefix}.members[${mi}]`, message: `"${raw}" is not a valid email address or domain`, code: 'invalid_member' })
        return
      }
      const id = memberIdentity(raw)
      if (seenMembers.has(id)) {
        errors.push({ field: `${prefix}.members[${mi}]`, message: `Duplicate member "${raw}"`, code: 'duplicate_member' })
      }
      seenMembers.add(id)
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
