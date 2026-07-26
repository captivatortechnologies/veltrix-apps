import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra Conditional Access policy constraints -----------------------------

export const MAX_NAME_LENGTH = 256
/** Canvas-facing state values (mapped to Graph state at deploy time). */
export const CANVAS_STATES = ['report-only', 'enabled', 'disabled'] as const
export const GRANT_OPERATORS = ['OR', 'AND'] as const
export const BUILT_IN_CONTROLS = [
  'mfa',
  'compliantDevice',
  'domainJoinedDevice',
  'approvedApplication',
  'compliantApplication',
  'passwordChange',
  'block',
] as const

/** Map the canvas state to the Microsoft Graph conditionalAccessPolicy state. */
export function mapCanvasStateToGraph(state: string): string {
  switch (state) {
    case 'enabled':
      return 'enabled'
    case 'disabled':
      return 'disabled'
    default:
      // report-only (and any unknown) is the safe default — never enforced.
      return 'enabledForReportingButNotEnforced'
  }
}

export interface CaPolicySpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  /** 'report-only' | 'enabled' | 'disabled'. */
  state: string
  includeAllUsers: boolean
  /** Group display names (resolved to ids at deploy time). */
  includeGroups: string[]
  excludeGroups: string[]
  includeAllApps: boolean
  /** App ids or well-known keywords (e.g. Office365); passed to Graph as-is. */
  includeApps: string[]
  grantOperator: string
  builtInControls: string[]
}

/** A CA policy as returned by Graph GET /identity/conditionalAccess/policies. */
export interface LiveCaPolicy {
  id?: string
  displayName?: string
  state?: string
  conditions?: {
    users?: { includeUsers?: string[]; includeGroups?: string[]; excludeGroups?: string[] }
    applications?: { includeApplications?: string[] }
  }
  grantControls?: { operator?: string; builtInControls?: string[] } | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Coerce a multiselect (array) or a delimited string into trimmed tokens. */
export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function extractPolicySpecs(canvas: CanvasSnapshot): CaPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      state: (asString(f.state) || 'report-only').toLowerCase(),
      includeAllUsers: asBool(f.includeAllUsers),
      includeGroups: asStringArray(f.includeGroups),
      excludeGroups: asStringArray(f.excludeGroups),
      includeAllApps: asBool(f.includeAllApps),
      includeApps: asStringArray(f.includeApps),
      grantOperator: (asString(f.grantOperator) || 'OR').toUpperCase(),
      builtInControls: asStringArray(f.builtInControls).map((c) => c.trim()),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // name — required, length, uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // state — enum
    if (!(CANVAS_STATES as readonly string[]).includes(spec.state)) {
      errors.push({
        field: `${prefix}.state`,
        message: `State must be one of: ${CANVAS_STATES.join(', ')}`,
        code: 'invalid_state',
      })
    }

    // users — at least one include target
    if (!spec.includeAllUsers && spec.includeGroups.length === 0) {
      errors.push({
        field: `${prefix}.includeGroups`,
        message: 'Target at least one user population: enable "All users" or name at least one included group',
        code: 'no_user_target',
      })
    }

    // applications — at least one include target
    if (!spec.includeAllApps && spec.includeApps.length === 0) {
      errors.push({
        field: `${prefix}.includeApps`,
        message: 'Target at least one cloud app: enable "All cloud apps" or list at least one app id / keyword',
        code: 'no_app_target',
      })
    }

    // grant controls — operator enum + at least one control + block exclusivity
    if (!(GRANT_OPERATORS as readonly string[]).includes(spec.grantOperator)) {
      errors.push({
        field: `${prefix}.grantOperator`,
        message: `Grant operator must be one of: ${GRANT_OPERATORS.join(', ')}`,
        code: 'invalid_operator',
      })
    }
    if (spec.builtInControls.length === 0) {
      errors.push({
        field: `${prefix}.builtInControls`,
        message: 'Select at least one grant control (e.g. mfa), or Block access',
        code: 'no_grant_control',
      })
    } else {
      const invalid = spec.builtInControls.filter(
        (c) => !(BUILT_IN_CONTROLS as readonly string[]).includes(c)
      )
      if (invalid.length) {
        errors.push({
          field: `${prefix}.builtInControls`,
          message: `Unknown grant control(s): ${invalid.join(', ')}. Allowed: ${BUILT_IN_CONTROLS.join(', ')}`,
          code: 'invalid_grant_control',
        })
      }
      if (spec.builtInControls.includes('block') && spec.builtInControls.length > 1) {
        errors.push({
          field: `${prefix}.builtInControls`,
          message: '"block" cannot be combined with other grant controls — it must be the only one',
          code: 'block_not_exclusive',
        })
      }
    }

    // Safety warning: an enforced policy with no break-glass exclusion can lock
    // every admin out. Warn (not error) so it's a deliberate choice.
    if (spec.state === 'enabled' && spec.excludeGroups.length === 0) {
      warnings.push({
        field: `${prefix}.excludeGroups`,
        message:
          'This policy is set to Enabled (enforced) with no excluded groups — consider excluding a break-glass / emergency-access group to avoid locking yourself out',
        code: 'no_break_glass',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
