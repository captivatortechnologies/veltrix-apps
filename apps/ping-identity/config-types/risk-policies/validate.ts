import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- PingOne Protect Risk Policies API constraints ---------------------------
// https://apidocs.pingidentity.com/pingone/platform/v1/api/#risk-policies
//
// GET/POST       /riskPolicySets       - list ({ _embedded: { riskPolicySets: [...] } }) / create
// GET/PUT/DELETE /riskPolicySets/{id}  - read / update / delete
//
// ONE resource type, no child sub-resources: the ordered override/mitigation
// rules (`riskPolicies`) are an EMBEDDED array sent whole on every create or
// update. Array order IS the evaluation priority (first match wins); the
// server assigns a `priority` back per entry on read that must never be sent.
// `defaultResult` currently only accepts `{level:"LOW"}`, so it is fixed by
// deploy.ts and never modelled as a canvas field.

export const MAX_RISK_POLICY_SET_NAME_LENGTH = 256

/** The 4 condition kinds a riskPolicies[] entry's `condition.type` may be. */
export const RISK_POLICY_CONDITION_TYPES = [
  'IP_RANGE',
  'VALUE_COMPARISON',
  'AGGREGATED_WEIGHTS',
  'AGGREGATED_SCORES',
] as const
export type RiskPolicyConditionType = (typeof RISK_POLICY_CONDITION_TYPES)[number]

/** The 3 risk levels a riskPolicies[] entry's `result.level` may be. */
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const

/** Server-managed top-level fields to strip before a PUT (restore) or drift comparison. */
export const READONLY_RISK_POLICY_SET_FIELDS = [
  'id',
  'environment',
  'createdAt',
  'updatedAt',
  '_links',
  'triggers',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface RiskPolicySetSpec {
  sectionName: string
  /** Risk policy set name - the logical identity deploy matches on. */
  name: string
  description?: string
  /** Whether this set should become the environment's default risk policy set. */
  default: boolean
  /** Predictor ids to evaluate; empty means "every licensed predictor" (field omitted on deploy). */
  evaluatedPredictorIds: string[]
  /** Raw riskPolicies JSON string (a JSON array of policy objects); blank = no override rules. */
  riskPoliciesJson?: string
}

/**
 * Shape of a set returned by GET /riskPolicySets and /riskPolicySets/{id}.
 * Carries an index signature so server-managed fields not modeled above
 * remain readable.
 */
export interface LiveRiskPolicySet {
  id?: string
  name?: string
  description?: string
  default?: boolean
  defaultResult?: { level?: string }
  evaluatedPredictors?: Array<{ id?: string }>
  riskPolicies?: Array<Record<string, unknown>>
  environment?: unknown
  createdAt?: string
  updatedAt?: string
  triggers?: unknown
  _links?: unknown
  [key: string]: unknown
}

/** Canvas list fields (tags/remote-multiselect) arrive as arrays, or comma/newline text. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas item describes one PingOne Protect risk policy set. */
export function extractRiskPolicySetSpecs(canvas: CanvasSnapshot): RiskPolicySetSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      default: fields.default === true,
      evaluatedPredictorIds: toStringList(fields.evaluatedPredictorIds),
      riskPoliciesJson:
        typeof fields.riskPoliciesJson === 'string' && fields.riskPoliciesJson.trim()
          ? fields.riskPoliciesJson.trim()
          : undefined,
    }
  })
}

/**
 * Parse a raw riskPolicies string, returning the array or null when the
 * string is not a JSON ARRAY. Elements are NOT shape-checked here - callers
 * run checkRiskPolicyElement per entry.
 */
export function parseRiskPoliciesArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one riskPolicies[] element against the discriminated `condition`
 * union and the `result` shape. Returns a human-readable error message, or
 * null when the element is structurally sound.
 */
export function checkRiskPolicyElement(policy: unknown, index: number): string | null {
  if (!isPlainObject(policy)) return `Policy at index ${index} must be a JSON object`

  const condition = policy.condition
  if (!isPlainObject(condition)) {
    return `Policy at index ${index} is missing a "condition" object`
  }

  const type = condition.type
  if (typeof type !== 'string' || !(RISK_POLICY_CONDITION_TYPES as readonly string[]).includes(type)) {
    return `Policy at index ${index}: condition.type must be one of ${RISK_POLICY_CONDITION_TYPES.join(', ')}`
  }
  if (type === 'IP_RANGE' && !(Array.isArray(condition.ipRange) && condition.ipRange.length > 0)) {
    return `Policy at index ${index}: an IP_RANGE condition needs a non-empty "ipRange" array of CIDR ranges`
  }
  if (type === 'VALUE_COMPARISON' && condition.equals === undefined) {
    return `Policy at index ${index}: a VALUE_COMPARISON condition needs an "equals" value`
  }

  const result = policy.result
  if (!isPlainObject(result)) return `Policy at index ${index} is missing a "result" object`
  if (result.level !== undefined && !(RISK_LEVELS as readonly string[]).includes(result.level as string)) {
    return `Policy at index ${index}: result.level must be one of ${RISK_LEVELS.join(', ')}`
  }

  return null
}

/** Strip the server-assigned `priority` a live riskPolicies[] entry carries - derived from array position, never sent or compared. */
export function stripPolicyPriority(policies: unknown): Record<string, unknown>[] {
  if (!Array.isArray(policies)) return []
  return policies.map((policy) => {
    if (!isPlainObject(policy)) return policy as Record<string, unknown>
    const { priority: _priority, ...rest } = policy
    return rest
  })
}

/** Copy a live risk policy set without the server-managed readOnly fields, with each riskPolicies[] priority stripped - safe to PUT back. */
export function stripReadOnlyRiskPolicySet(set: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set<string>(READONLY_RISK_POLICY_SET_FIELDS)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(set)) {
    if (!drop.has(key)) out[key] = value
  }
  if (Array.isArray(out.riskPolicies)) out.riskPolicies = stripPolicyPriority(out.riskPolicies)
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate risk policy set configurations against the PingOne Protect Risk
 * Policies API. Static only - it never contacts PingOne (options for
 * evaluatedPredictorIds are resolved live by the platform's remote-multiselect
 * UI via options.ts, not here):
 *   - name is required, <= 256 chars, and unique within the canvas
 *   - riskPoliciesJson, when set, parses to a JSON ARRAY where every element
 *     has a `condition.type` in the 4 supported values (with the type-specific
 *     shape it needs) and a `result` whose `level`, when present, is LOW/MEDIUM/HIGH
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRiskPolicySetSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name - required, <= 256 chars, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Risk policy set name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RISK_POLICY_SET_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Risk policy set name must be ${MAX_RISK_POLICY_SET_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate risk policy set "${spec.name}" - each set may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // riskPoliciesJson - optional; when set it must parse to a JSON ARRAY, and
    // each element must carry a supported condition.type (plus that type's
    // required shape) and a valid result.level when one is given.
    if (spec.riskPoliciesJson) {
      const policies = parseRiskPoliciesArray(spec.riskPoliciesJson)
      if (policies === null) {
        errors.push({
          field: `${prefix}.riskPoliciesJson`,
          message:
            'Policies must be a valid JSON array of policy objects, e.g. [{"condition":{"type":"IP_RANGE","ipRange":["203.0.113.0/24"]},"result":{"level":"HIGH"}}] - see the field help for more examples',
          code: 'invalid_policies',
        })
      } else {
        policies.forEach((policy, index) => {
          const problem = checkRiskPolicyElement(policy, index)
          if (problem) {
            errors.push({ field: `${prefix}.riskPoliciesJson[${index}]`, message: problem, code: 'invalid_policy_element' })
          }
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
