import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// CyberArk Automatic Onboarding Rules — validate + shared spec extraction.
//
// An onboarding rule filters accounts that CyberArk's discovery finds and
// onboards each match to a target Safe against a target Platform. CyberArk
// assigns a numeric `RuleId` (used to update / delete), so the logical identity
// for reconciliation is the natural key: the (unique) rule name.
// =============================================================================

/** Mandatory system type the rule matches. */
export const SYSTEM_TYPES = ['Windows', 'Unix'] as const
export type SystemType = (typeof SYSTEM_TYPES)[number]

/** Machine types a rule can filter by. */
export const MACHINE_TYPES = ['Any', 'Workstation', 'Server'] as const
export type MachineType = (typeof MACHINE_TYPES)[number]

/** Account categories a rule can filter by. */
export const ACCOUNT_CATEGORIES = ['Any', 'Privileged', 'Non-privileged'] as const
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number]

/** Match methods for the username / address filters. */
export const MATCH_METHODS = ['Equals', 'Begins', 'Ends'] as const
export type MatchMethod = (typeof MATCH_METHODS)[number]

const SYSTEM_TYPE_SET = new Set<string>(SYSTEM_TYPES)
const MACHINE_TYPE_SET = new Set<string>(MACHINE_TYPES)
const ACCOUNT_CATEGORY_SET = new Set<string>(ACCOUNT_CATEGORIES)
const MATCH_METHOD_SET = new Set<string>(MATCH_METHODS)

export interface OnboardingRuleSpec {
  sectionName: string
  ruleName: string
  ruleDescription: string
  targetPlatformId: string
  targetSafeName: string
  /** Raw values — validated against their enums (deploy runs post-validate). */
  systemTypeFilter: string
  machineTypeFilter: string
  accountCategoryFilter: string
  isAdminIdFilter: boolean
  userNameFilter: string
  userNameMethod: string
  addressFilter: string
  addressMethod: string
}

/** Shape of a rule returned by GET /AutomaticOnboardingRules (only fields we manage). */
export interface LiveOnboardingRule {
  RuleId?: number
  RuleName?: string
  TargetPlatformId?: string
  TargetSafeName?: string
  SystemTypeFilter?: string
  MachineTypeFilter?: string
  AccountCategoryFilter?: string
  IsAdminIDFilter?: boolean
  UserNameFilter?: string
  UserNameMethod?: string
  AddressFilter?: string
  AddressMethod?: string
  RuleDescription?: string
}

/** A rule's natural key — its name, lower-cased for reconciliation. */
export function ruleKey(spec: { ruleName: string }): string {
  return spec.ruleName.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function readEnum(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** Each canvas item describes one onboarding rule. */
export function extractOnboardingRuleSpecs(canvas: CanvasSnapshot): OnboardingRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      ruleName: typeof fields.rule_name === 'string' ? fields.rule_name.trim() : '',
      ruleDescription: typeof fields.rule_description === 'string' ? fields.rule_description.trim() : '',
      targetPlatformId: typeof fields.target_platform_id === 'string' ? fields.target_platform_id.trim() : '',
      targetSafeName: typeof fields.target_safe_name === 'string' ? fields.target_safe_name.trim() : '',
      systemTypeFilter: readEnum(fields.system_type_filter, 'Windows'),
      machineTypeFilter: readEnum(fields.machine_type_filter, 'Any'),
      accountCategoryFilter: readEnum(fields.account_category_filter, 'Any'),
      isAdminIdFilter: readBool(fields.is_admin_id_filter, false),
      userNameFilter: typeof fields.user_name_filter === 'string' ? fields.user_name_filter.trim() : '',
      userNameMethod: readEnum(fields.user_name_method, 'Equals'),
      addressFilter: typeof fields.address_filter === 'string' ? fields.address_filter.trim() : '',
      addressMethod: readEnum(fields.address_method, 'Equals'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate onboarding-rule configurations: rule name, target platform id and
 * target safe are required; the system type, machine type, account category and
 * match methods must be supported values; length limits are enforced; and the
 * rule name (its natural key) is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractOnboardingRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    } else if (spec.ruleName.length > 255) {
      errors.push({ field: `${prefix}.rule_name`, message: `Rule name "${spec.ruleName}" exceeds the 255-character limit`, code: 'rule_name_too_long' })
    }
    if (!spec.targetPlatformId) {
      errors.push({ field: `${prefix}.target_platform_id`, message: 'Target platform ID is required', code: 'required' })
    } else if (spec.targetPlatformId.length > 99) {
      errors.push({ field: `${prefix}.target_platform_id`, message: 'Target platform ID exceeds the 99-character limit', code: 'platform_id_too_long' })
    }
    if (!spec.targetSafeName) {
      errors.push({ field: `${prefix}.target_safe_name`, message: 'Target safe name is required', code: 'required' })
    } else if (spec.targetSafeName.length > 28) {
      errors.push({ field: `${prefix}.target_safe_name`, message: 'Target safe name exceeds the 28-character CyberArk limit', code: 'safe_name_too_long' })
    }

    if (!SYSTEM_TYPE_SET.has(spec.systemTypeFilter)) {
      errors.push({ field: `${prefix}.system_type_filter`, message: `Unsupported system type "${spec.systemTypeFilter}"`, code: 'invalid_system_type' })
    }
    if (!MACHINE_TYPE_SET.has(spec.machineTypeFilter)) {
      errors.push({ field: `${prefix}.machine_type_filter`, message: `Unsupported machine type "${spec.machineTypeFilter}"`, code: 'invalid_machine_type' })
    }
    if (!ACCOUNT_CATEGORY_SET.has(spec.accountCategoryFilter)) {
      errors.push({ field: `${prefix}.account_category_filter`, message: `Unsupported account category "${spec.accountCategoryFilter}"`, code: 'invalid_account_category' })
    }
    if (!MATCH_METHOD_SET.has(spec.userNameMethod)) {
      errors.push({ field: `${prefix}.user_name_method`, message: `Unsupported username match method "${spec.userNameMethod}"`, code: 'invalid_match_method' })
    }
    if (!MATCH_METHOD_SET.has(spec.addressMethod)) {
      errors.push({ field: `${prefix}.address_method`, message: `Unsupported address match method "${spec.addressMethod}"`, code: 'invalid_match_method' })
    }
    if (spec.userNameFilter.length > 512) {
      errors.push({ field: `${prefix}.user_name_filter`, message: 'Username filter exceeds the 512-character limit', code: 'filter_too_long' })
    }
    if (spec.addressFilter.length > 255) {
      errors.push({ field: `${prefix}.address_filter`, message: 'Address filter exceeds the 255-character limit', code: 'filter_too_long' })
    }

    if (spec.ruleName) {
      const key = ruleKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_name`,
          message: `Duplicate rule "${spec.ruleName}" — each rule name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
