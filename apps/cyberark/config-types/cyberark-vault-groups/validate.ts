import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// CyberArk Vault User Groups — validate + shared spec extraction.
//
// A Vault group clusters Vault or domain identities under one name for
// authorization purposes (distinct from cyberark-directory-mappings, which
// maps an LDAP group onto Vault groups automatically — this type manages the
// Vault GROUP OBJECT and its direct membership). CyberArk assigns a numeric
// id, so reconciliation uses the natural key: group name.
//
// Unlike Account Groups, UserGroups DOES expose a full delete endpoint, so
// this type is fully reversible on rollback (create/update/delete all
// covered) — no partial-rollback caveat needed here.
//
// NO SECRET MATERIAL: a group's fields are names/ids and member references.
// =============================================================================

export const MEMBER_TYPES = ['vault', 'domain'] as const
export type GroupMemberType = (typeof MEMBER_TYPES)[number]

const MEMBER_TYPE_SET = new Set<string>(MEMBER_TYPES)

export interface GroupMemberSpec {
  memberId: string
  memberType: GroupMemberType
  domainName?: string
}

export interface VaultGroupSpec {
  sectionName: string
  groupName: string
  description: string
  location: string
  /** Raw JSON as typed on the canvas — re-parsed by deploy via parseGroupMembers(). */
  membersJson: string
}

/** Shape of a Vault group returned by GET /UserGroups/{id} (only fields we manage). */
export interface LiveVaultGroup {
  id?: string | number
  groupName?: string
  description?: string
  location?: string
  groupType?: string
  members?: LiveGroupMember[]
}

/** Shape of a member as GET .../UserGroups/{id}?includeMembers=True returns it. */
export interface LiveGroupMember {
  username?: string
  memberId?: string
  memberType?: string
  domainName?: string
}

/** A group's natural key — its name, lower-cased for reconciliation. */
export function vaultGroupKey(spec: { groupName: string }): string {
  return spec.groupName.trim().toLowerCase()
}

/** Each canvas item describes one Vault group. */
export function extractVaultGroupSpecs(canvas: CanvasSnapshot): VaultGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      groupName: typeof fields.group_name === 'string' ? fields.group_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      location: typeof fields.location === 'string' && fields.location.trim() ? fields.location.trim() : '\\',
      membersJson: typeof fields.members === 'string' ? fields.members : '',
    }
  })
}

export interface GroupMembersResult {
  value: GroupMemberSpec[] | null
  error: string | null
}

/** Parse the `members` JSON array. Empty string → []. */
export function parseGroupMembers(raw: string): GroupMembersResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { value: null, error: 'must be a JSON array of member objects' }

  const members: GroupMemberSpec[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { value: null, error: `entry [${i}] must be an object` }
    }
    const raw = entry as Record<string, unknown>
    const memberId = typeof raw.member_id === 'string' ? raw.member_id.trim() : ''
    const memberType = typeof raw.member_type === 'string' ? raw.member_type.trim() : ''
    const domainName = typeof raw.domain_name === 'string' ? raw.domain_name.trim() : undefined
    if (!memberId) return { value: null, error: `entry [${i}] needs a non-empty "member_id"` }
    if (!MEMBER_TYPE_SET.has(memberType)) {
      return { value: null, error: `entry [${i}].member_type "${memberType}" must be one of ${MEMBER_TYPES.join(', ')}` }
    }
    if (memberType === 'domain' && !domainName) {
      return { value: null, error: `entry [${i}] is member_type "domain" and needs a non-empty "domain_name"` }
    }
    members.push({ memberId, memberType: memberType as GroupMemberType, domainName })
  }
  return { value: members, error: null }
}

/** A member's natural key — (memberId, memberType), for diffing against live membership. */
export function groupMemberKey(m: { memberId: string; memberType: string }): string {
  return JSON.stringify([m.memberId.trim().toLowerCase(), m.memberType.trim().toLowerCase()])
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Vault-group configurations: group name is required and unique;
 * members (when set) must parse per parseGroupMembers() with no duplicate
 * member within one group.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractVaultGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.groupName) errors.push({ field: `${prefix}.group_name`, message: 'Group name is required', code: 'required' })

    const members = parseGroupMembers(spec.membersJson)
    if (members.error) {
      errors.push({ field: `${prefix}.members`, message: `Members ${members.error}`, code: 'invalid_members' })
    } else if (members.value) {
      const memberSeen = new Set<string>()
      members.value.forEach((m, i) => {
        const key = groupMemberKey(m)
        if (memberSeen.has(key)) {
          errors.push({
            field: `${prefix}.members[${i}]`,
            message: `Duplicate member "${m.memberId}" — each member may only be declared once per group`,
            code: 'duplicate_member',
          })
        }
        memberSeen.add(key)
      })
    }

    if (spec.groupName) {
      const key = vaultGroupKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.group_name`,
          message: `Duplicate group "${spec.groupName}" — each group name may only be declared once`,
          code: 'duplicate_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
