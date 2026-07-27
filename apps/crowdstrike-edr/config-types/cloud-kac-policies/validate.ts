import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- Kubernetes Admission Control (KAC) Policy API constraints ----------------

/** Action a KAC default rule / rule group applies to an admission request. */
export const KAC_ACTIONS = ['Disabled', 'Alert', 'Prevent'] as const

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface KacPolicySpec {
  sectionName: string
  name: string
  description?: string
  enabled: boolean
  /** Policy-level default action for its rule groups (Disabled|Alert|Prevent). */
  defaultAction: string
  hostGroups: string[]
  /** Raw rule_groups JSON as authored on the canvas — parsed by parseRuleGroups. */
  ruleGroupsRaw?: string
}

/**
 * Shape of a policy returned by GET /admission-control-policies/entities/policies/v1.
 * Read tolerantly: enablement is `is_enabled` on the write model but may surface
 * as `enabled` on reads; host groups may be a string[] or an object list.
 */
export interface LiveKacPolicy {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  is_enabled?: boolean
  host_groups?: string[]
  groups?: Array<{ id?: string; name?: string }>
  rule_groups?: unknown[]
  default_rule_group?: unknown
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Each canvas section describes one KAC policy. */
export function extractKacPolicySpecs(canvas: CanvasSnapshot): KacPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawAction =
      typeof fields.defaultAction === 'string' && fields.defaultAction.trim()
        ? fields.defaultAction.trim()
        : 'Alert'
    const defaultAction =
      (KAC_ACTIONS as readonly string[]).find((a) => a.toLowerCase() === rawAction.toLowerCase()) ??
      rawAction

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      enabled: coerceBoolean(fields.enabled, false),
      defaultAction,
      hostGroups: splitList(fields.hostGroups),
      ruleGroupsRaw:
        typeof fields.ruleGroups === 'string' && fields.ruleGroups.trim()
          ? fields.ruleGroups.trim()
          : undefined,
    }
  })
}

/**
 * Parse and structurally validate the rule_groups JSON. Phase 3 keeps the deeply
 * nested rule-group model opaque: it must parse to an array whose entries are
 * objects, each with a non-empty `name` (unique within the policy). The nested
 * namespaces/labels/image_assessment/default_rules/custom_rules are passed
 * through verbatim and are the concern of the separate policy-rule-groups API.
 */
export function parseRuleGroups(raw: string | undefined): {
  ruleGroups: Array<Record<string, unknown>>
  errors: string[]
} {
  if (!raw) return { ruleGroups: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ruleGroups: [],
      errors: [`Rule groups is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { ruleGroups: [], errors: ['Rule groups must be a JSON array of rule group objects'] }
  }

  const ruleGroups: Array<Record<string, unknown>> = []
  const errors: string[] = []
  const seenNames = new Set<string>()

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Rule group #${index + 1}: must be an object`)
      return
    }
    const e = entry as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!name) {
      errors.push(`Rule group #${index + 1}: "name" must be a non-empty string`)
      return
    }
    if (seenNames.has(name.toLowerCase())) {
      errors.push(`Rule group "${name}": declared more than once`)
      return
    }
    seenNames.add(name.toLowerCase())
    ruleGroups.push(e)
  })

  return { ruleGroups, errors }
}

/** Structural deep equality — used by drift to compare declared vs live rule_groups. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => deepEqual(value, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const aKeys = Object.keys(ao)
    if (aKeys.length !== Object.keys(bo).length) return false
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEqual(ao[key], bo[key]),
    )
  }
  return false
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate KAC policy configurations against the Admission Control Policy API:
 * naming, the default action enum, host group targeting, and that the rule_groups
 * payload parses to an array of named rule group objects.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractKacPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, length-bounded, unique per canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // default action enum
    if (!(KAC_ACTIONS as readonly string[]).includes(spec.defaultAction)) {
      errors.push({
        field: `${prefix}.defaultAction`,
        message: `Default action must be one of: ${KAC_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }

    // rule_groups JSON
    const { ruleGroups, errors: ruleGroupErrors } = parseRuleGroups(spec.ruleGroupsRaw)
    for (const message of ruleGroupErrors) {
      errors.push({ field: `${prefix}.ruleGroups`, message, code: 'invalid_rule_groups' })
    }

    // an enabled policy assigned to no host groups admits nothing
    if (spec.enabled && spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message: 'Policy is enabled but assigned to no host groups — it will not apply to any clusters',
        code: 'no_host_groups',
      })
    }

    // an enabled policy with no rule groups only applies its default rule group
    if (spec.enabled && ruleGroupErrors.length === 0 && ruleGroups.length === 0) {
      warnings.push({
        field: `${prefix}.ruleGroups`,
        message: 'Policy is enabled but declares no rule groups — only the default rule group applies',
        code: 'no_rule_groups',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
