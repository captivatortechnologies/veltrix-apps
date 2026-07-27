import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA private-access policy rule constraints ----------------------

export const MAX_NAME_LENGTH = 255
export const RULE_ACTIONS = ['allow', 'block'] as const
export type RuleAction = (typeof RULE_ACTIONS)[number]
/** rule_data.json_version is a fixed contract version for NPA private-app rules. */
export const JSON_VERSION = 3

export interface RuleSpec {
  itemId?: string
  /** rule_name — the logical identity (rules are id-addressed; the app matches
   *  on name and stores the numeric id for rename-safety). */
  name: string
  description: string
  enabled: boolean
  /** Policy group NAME; resolved to group_id against the live groups at deploy. */
  group: string
  action: string
  privateApps: string[]
  privateAppTags: string[]
  users: string[]
  userGroups: string[]
  organizationUnits: string[]
  accessMethods: string[]
  deviceClassificationIds: string[]
  netLocationObjs: string[]
  srcCountries: string[]
  negateNetLocation: boolean
  negateSrcCountries: boolean
}

/** A rule as returned by GET /api/v2/policy/npa/rules (NPA {data} envelope). */
export interface LiveRule {
  rule_id?: number | string
  id?: number | string
  rule_name?: string
  description?: string
  enabled?: string | boolean
  group_id?: number | string
  rule_data?: {
    policy_type?: string
    match_criteria_action?: { action_name?: string }
    private_apps?: string[]
    private_app_tags?: string[]
    users?: string[]
    user_groups?: string[]
    organization_units?: string[]
    access_method?: string[]
    device_classification_id?: string[]
    net_location_obj?: string[]
    src_countries?: string[]
    b_negate_net_location?: boolean
    b_negate_src_countries?: boolean
    json_version?: number
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array value into trimmed, non-empty entries. */
export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Netskope returns private-app names bracket-wrapped (e.g. "[CRM]"); trim them
 *  so declared and live names compare equal. */
export function trimBrackets(v: string): string {
  return v.replace(/^\[(.*)\]$/, '$1').trim()
}

export function liveRuleId(l: LiveRule): string | undefined {
  const v = l.rule_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractRuleSpecs(canvas: CanvasSnapshot): RuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.rule_name) || item.name,
      description: asString(f.description),
      enabled: f.enabled !== false,
      group: asString(f.group),
      action: asString(f.action) || 'allow',
      privateApps: splitEntries(f.private_apps),
      privateAppTags: splitEntries(f.private_app_tags),
      users: splitEntries(f.users),
      userGroups: splitEntries(f.user_groups),
      organizationUnits: splitEntries(f.organization_units),
      accessMethods: splitEntries(f.access_method),
      deviceClassificationIds: splitEntries(f.device_classification_id),
      netLocationObjs: splitEntries(f.net_location_obj),
      srcCountries: splitEntries(f.src_countries),
      negateNetLocation: f.b_negate_net_location === true,
      negateSrcCountries: f.b_negate_src_countries === true,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.rule_name`, message: `Rule name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.rule_name`, message: `Duplicate rule "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!RULE_ACTIONS.includes(spec.action as RuleAction)) {
      errors.push({ field: `${prefix}.action`, message: `Action must be one of ${RULE_ACTIONS.join(', ')}`, code: 'invalid_action' })
    }

    if (spec.privateApps.length === 0 && spec.privateAppTags.length === 0) {
      warnings.push({ field: `${prefix}.private_apps`, message: 'No private apps or app tags — this rule will not match any application', code: 'no_apps' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
