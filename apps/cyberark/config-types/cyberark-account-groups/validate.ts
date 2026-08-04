import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// CyberArk Account Groups — validate + shared spec extraction.
//
// An account group clusters accounts (typically for group-based credential
// rotation, e.g. a set of dependent accounts sharing a password) under one
// GroupPlatformID within a Safe. CyberArk assigns a numeric GroupID, so
// reconciliation uses the natural key: (Safe, GroupName).
//
// ⚠ NO DELETE-GROUP ENDPOINT is exposed by the Gen2 AccountGroups API — only
// members can be removed over REST, never the group object itself. See
// rollback.ts and README "Coverage" for the resulting partial-rollback note.
//
// NO SECRET MATERIAL: a group's own fields are just names/ids, and a member
// reference is (account name, safe) — resolved to CyberArk's internal
// AccountID at deploy time. No secret ever appears here.
// =============================================================================

export interface AccountGroupMemberSpec {
  accountName: string
  safeName: string
}

export interface AccountGroupSpec {
  sectionName: string
  groupName: string
  safeName: string
  groupPlatformId: string
  /** Raw JSON as typed on the canvas — re-parsed by deploy via parseMembers(). */
  membersJson: string
}

/** Shape of an account group returned by GET /AccountGroups (only fields we manage). */
export interface LiveAccountGroup {
  GroupID?: string | number
  GroupName?: string
  GroupPlatformID?: string
  Safe?: string
}

/** A group's natural key — (Safe, GroupName), both lower-cased for reconciliation. */
export function groupKey(spec: { safeName: string; groupName: string }): string {
  return JSON.stringify([spec.safeName.trim().toLowerCase(), spec.groupName.trim().toLowerCase()])
}

/** A member's natural key — (account name, safe), both lower-cased. */
export function memberSpecKey(m: { accountName: string; safeName: string }): string {
  return JSON.stringify([m.accountName.trim().toLowerCase(), m.safeName.trim().toLowerCase()])
}

/** Each canvas item describes one CyberArk account group. */
export function extractAccountGroupSpecs(canvas: CanvasSnapshot): AccountGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      groupName: typeof fields.group_name === 'string' ? fields.group_name.trim() : '',
      safeName: typeof fields.safe_name === 'string' ? fields.safe_name.trim() : '',
      groupPlatformId: typeof fields.group_platform_id === 'string' ? fields.group_platform_id.trim() : '',
      membersJson: typeof fields.members === 'string' ? fields.members : '',
    }
  })
}

export interface MembersResult {
  value: AccountGroupMemberSpec[] | null
  error: string | null
}

/** Parse the `members` JSON array. Empty string → []. Each entry needs account_name + safe_name. */
export function parseMembers(raw: string): MembersResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { value: null, error: 'must be a JSON array of { account_name, safe_name } objects' }

  const members: AccountGroupMemberSpec[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { value: null, error: `entry [${i}] must be an object` }
    }
    const raw = entry as Record<string, unknown>
    const accountName = typeof raw.account_name === 'string' ? raw.account_name.trim() : ''
    const safeName = typeof raw.safe_name === 'string' ? raw.safe_name.trim() : ''
    if (!accountName || !safeName) {
      return { value: null, error: `entry [${i}] needs non-empty "account_name" and "safe_name"` }
    }
    members.push({ accountName, safeName })
  }
  return { value: members, error: null }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate account-group configurations: group name, safe and group platform
 * id are required; members (when set) must parse per parseMembers() with no
 * duplicate member within one group; the (safe, group name) natural key is
 * unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccountGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.groupName) errors.push({ field: `${prefix}.group_name`, message: 'Group name is required', code: 'required' })
    if (!spec.safeName) errors.push({ field: `${prefix}.safe_name`, message: 'Safe name is required', code: 'required' })
    if (!spec.groupPlatformId) errors.push({ field: `${prefix}.group_platform_id`, message: 'Group platform ID is required', code: 'required' })

    const members = parseMembers(spec.membersJson)
    if (members.error) {
      errors.push({ field: `${prefix}.members`, message: `Members ${members.error}`, code: 'invalid_members' })
    } else if (members.value) {
      const memberSeen = new Set<string>()
      members.value.forEach((m, i) => {
        const key = memberSpecKey(m)
        if (memberSeen.has(key)) {
          errors.push({
            field: `${prefix}.members[${i}]`,
            message: `Duplicate member "${m.accountName} @ ${m.safeName}" — each member may only be declared once per group`,
            code: 'duplicate_member',
          })
        }
        memberSeen.add(key)
      })
    }

    if (spec.groupName && spec.safeName) {
      const key = groupKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.group_name`,
          message: `Duplicate account group "${spec.groupName}" in safe "${spec.safeName}" — each (safe, group name) may only be declared once`,
          code: 'duplicate_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
