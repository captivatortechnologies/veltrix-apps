import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud custom policy constraints ----------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export const POLICY_TYPES = ['config', 'audit_event', 'iam', 'network', 'data', 'anomaly', 'attack_path']
export const CLOUD_TYPES = ['aws', 'azure', 'gcp', 'alibaba_cloud', 'oci', 'all']
export const SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical']
export const RULE_TYPES = ['Config', 'AuditEvent', 'IAM', 'Network', 'DLP', 'Anomaly', 'NetworkConfig']
/** Rule types whose `criteria` must be a Saved Search id. */
export const SAVED_SEARCH_RULE_TYPES = ['Config', 'AuditEvent', 'IAM', 'Network']
export const POLICY_SUBTYPES = ['build', 'run']

export interface PolicySpec {
  itemId?: string
  /** name — the identity (custom policy names are effectively unique). */
  name: string
  policyType: string
  cloudType: string
  severity: string
  description: string
  enabled: boolean
  recommendation: string
  labels: string[]
  policySubTypes: string[]
  ruleName: string
  ruleType: string
  /** criteria — a Saved Search id for Config/AuditEvent/IAM/Network rule types. */
  criteria: string
  resourceType: string
  withIac: boolean
}

/** A policy as returned by GET /v2/policy. */
export interface LivePolicy {
  policyId?: string
  name?: string
  policyType?: string
  cloudType?: string
  severity?: string
  description?: string | null
  enabled?: boolean
  recommendation?: string
  labels?: string[]
  policySubTypes?: string[]
  rule?: Record<string, unknown>
  systemDefault?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function splitList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      policyType: asString(f.policyType) || 'config',
      cloudType: asString(f.cloudType) || 'all',
      severity: asString(f.severity) || 'low',
      description: asString(f.description),
      enabled: f.enabled === undefined ? true : asBool(f.enabled),
      recommendation: asString(f.recommendation),
      labels: splitList(f.labels),
      policySubTypes: splitList(f.policySubTypes),
      ruleName: asString(f.ruleName),
      ruleType: asString(f.ruleType) || 'Config',
      criteria: asString(f.criteria),
      resourceType: asString(f.resourceType),
      withIac: asBool(f.withIac),
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

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate policy "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!POLICY_TYPES.includes(spec.policyType)) {
      errors.push({ field: `${prefix}.policyType`, message: `Policy type must be one of: ${POLICY_TYPES.join(', ')}`, code: 'invalid_policy_type' })
    }
    if (!CLOUD_TYPES.includes(spec.cloudType)) {
      errors.push({ field: `${prefix}.cloudType`, message: `Cloud type must be one of: ${CLOUD_TYPES.join(', ')}`, code: 'invalid_cloud_type' })
    }
    if (!SEVERITIES.includes(spec.severity)) {
      errors.push({ field: `${prefix}.severity`, message: `Severity must be one of: ${SEVERITIES.join(', ')}`, code: 'invalid_severity' })
    }
    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.ruleType) {
      errors.push({ field: `${prefix}.ruleType`, message: 'Rule type is required', code: 'required' })
    } else if (!RULE_TYPES.includes(spec.ruleType)) {
      errors.push({ field: `${prefix}.ruleType`, message: `Rule type must be one of: ${RULE_TYPES.join(', ')}`, code: 'invalid_rule_type' })
    }

    if (SAVED_SEARCH_RULE_TYPES.includes(spec.ruleType) && !spec.criteria) {
      errors.push({ field: `${prefix}.criteria`, message: `Rule type "${spec.ruleType}" requires a saved-search id in criteria`, code: 'required' })
    }

    for (const st of spec.policySubTypes) {
      if (!POLICY_SUBTYPES.includes(st)) {
        errors.push({ field: `${prefix}.policySubTypes`, message: `Policy subtype "${st}" must be one of: ${POLICY_SUBTYPES.join(', ')}`, code: 'invalid_subtype' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
