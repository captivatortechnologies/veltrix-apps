import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz cloud configuration rule constraints --------------------------------

export const SEVERITIES = ['INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

/** IaC matcher types accepted by `CloudConfigurationRuleMatcherInput.type`. */
export const IAC_MATCHER_TYPES = [
  'TERRAFORM',
  'CLOUD_FORMATION',
  'KUBERNETES',
  'AZURE_RESOURCE_MANAGER',
  'DOCKER_FILE',
  'ADMISSION_CONTROLLER',
] as const

/** Sentinel select value meaning "no IaC matcher". */
export const NO_IAC_MATCHER = 'none'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface CloudConfigRuleSpec {
  sectionName: string
  name: string
  description: string
  severity: string
  enabled: boolean
  targetNativeTypes: string[]
  opaPolicy: string
  remediationInstructions: string
  functionAsControl: boolean
  securitySubCategories: string[]
  scopeAccountIds: string[]
  iacMatcherType: string
  iacRegoCode: string
}

/** A cloud configuration rule as returned by the `cloudConfigurationRules` list query. */
export interface LiveCloudConfigRule {
  id?: string
  name?: string
  builtin?: boolean | null
}

/** A cloud configuration rule as returned by the single-rule read query (full managed state). */
export interface FullCloudConfigRule {
  id?: string
  name?: string
  description?: string
  targetNativeTypes?: string[]
  opaPolicy?: string
  severity?: string
  enabled?: boolean | null
  remediationInstructions?: string
  functionAsControl?: boolean | null
  scopeAccounts?: Array<{ id?: string }>
  securitySubCategories?: Array<{ id?: string }>
  iacMatchers?: Array<{ type?: string; regoCode?: string }>
  builtin?: boolean | null
}

/** The rule's logical identity: its name (case-insensitive, trimmed). */
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas item describes one Wiz cloud configuration rule. */
export function extractCloudConfigRuleSpecs(canvas: CanvasSnapshot): CloudConfigRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      severity: str(fields.severity) || 'MEDIUM',
      enabled: readBool(fields.enabled, true),
      targetNativeTypes: strList(fields.target_native_types),
      opaPolicy: typeof fields.opa_policy === 'string' ? fields.opa_policy.trim() : '',
      remediationInstructions: str(fields.remediation_instructions),
      functionAsControl: readBool(fields.function_as_control, false),
      securitySubCategories: strList(fields.security_sub_categories),
      scopeAccountIds: strList(fields.scope_account_ids),
      iacMatcherType: str(fields.iac_matcher_type) || NO_IAC_MATCHER,
      iacRegoCode: typeof fields.iac_rego_code === 'string' ? fields.iac_rego_code.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz cloud configuration rule configurations: name is required and
 * unique across the canvas (case-insensitive); severity must be a supported
 * value; at least one target native type and a Rego (OPA) policy are required;
 * and an IaC matcher must pair a supported type with Rego code.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCloudConfigRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }
    if (!SEVERITIES.includes(spec.severity as (typeof SEVERITIES)[number])) {
      errors.push({ field: `${prefix}.severity`, message: `Unsupported severity "${spec.severity}"`, code: 'invalid_severity' })
    }
    if (spec.targetNativeTypes.length === 0) {
      errors.push({
        field: `${prefix}.target_native_types`,
        message: 'At least one target native type is required (e.g. aws.s3.bucket)',
        code: 'required',
      })
    }
    if (!spec.opaPolicy) {
      errors.push({ field: `${prefix}.opa_policy`, message: 'A Rego (OPA) cloud policy is required', code: 'required' })
    }

    // IaC matcher: type and rego code must be provided together.
    const hasMatcherType = spec.iacMatcherType !== NO_IAC_MATCHER
    if (hasMatcherType && !IAC_MATCHER_TYPES.includes(spec.iacMatcherType as (typeof IAC_MATCHER_TYPES)[number])) {
      errors.push({
        field: `${prefix}.iac_matcher_type`,
        message: `Unsupported IaC matcher type "${spec.iacMatcherType}"`,
        code: 'invalid_iac_matcher_type',
      })
    }
    if (hasMatcherType && !spec.iacRegoCode) {
      errors.push({
        field: `${prefix}.iac_rego_code`,
        message: 'IaC Rego code is required when an IaC matcher type is selected',
        code: 'required',
      })
    }
    if (!hasMatcherType && spec.iacRegoCode) {
      errors.push({
        field: `${prefix}.iac_matcher_type`,
        message: 'Select an IaC matcher type to use the IaC Rego code, or clear the code',
        code: 'required',
      })
    }

    if (spec.name) {
      const key = ruleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
