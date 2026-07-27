import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Identity Protection Policy Rule API constraints -------------------------
//
// Endpoints (Falcon Identity Protection):
//   query  GET    /identity-protection/queries/policy-rules/v1   (name/enabled/simulation_mode → rule ids)
//   get    GET    /identity-protection/entities/policy-rules/v1?ids=…
//   create POST   /identity-protection/entities/policy-rules/v1
//   delete DELETE /identity-protection/entities/policy-rules/v1?ids=…
//
// There is NO update/PATCH endpoint (verified against FalconPy's
// identity_protection service, which exposes only get/post/delete/query for
// policy rules). Any change is applied REPLACE-IN-PLACE: delete the old rule
// then create a new one (see deploy.ts).

/**
 * Allowed rule actions. CAVEAT: the Falcon REST schema types `action` as an
 * opaque "string" and does not publish an enum, so this set mirrors the actions
 * offered in the Falcon Identity Protection rule builder (and the Preempt
 * lineage the API descends from). Values are sent to the API verbatim.
 */
export const IDP_ACTIONS = ['ALLOW', 'DENY', 'MFA'] as const
export type IdpAction = (typeof IDP_ACTIONS)[number]

export const MAX_RULE_NAME_LENGTH = 255

/**
 * Keys the app manages as first-class fields — stripped from a user's
 * `conditions` JSON so it can never shadow a structured field, and excluded
 * from a live rule when rebuilding a create body.
 */
export const RESERVED_RULE_KEYS = ['id', 'name', 'enabled', 'simulationMode', 'action'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface IdpRuleSpec {
  sectionName: string
  name: string
  enabled: boolean
  simulationMode: boolean
  action: string
  /** Raw conditions JSON exactly as the user typed it (undefined when blank). */
  conditionsRaw?: string
  /** Optional ordering hint; controls the deploy creation sequence only. */
  precedence?: number
}

/** Shape of a rule returned by GET /identity-protection/entities/policy-rules/v1. */
export interface LiveIdpRule {
  id?: string
  name?: string
  enabled?: boolean
  simulationMode?: boolean
  action?: string
  activity?: unknown
  sourceUser?: unknown
  sourceEndpoint?: unknown
  destination?: unknown
  trigger?: unknown
  /**
   * Best-effort audit fields for drift attribution. Identity Protection rules
   * are NOT documented to expose a modifier, so these are usually absent and
   * attribution falls back to "unattributed" — read anyway so a future API that
   * does surface them is picked up for free.
   */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Each canvas section describes one Identity Protection policy rule. */
export function extractIdpRuleSpecs(canvas: CanvasSnapshot): IdpRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const rawAction = typeof fields.action === 'string' ? fields.action.trim().toUpperCase() : 'MFA'
    const rawPrecedence = typeof fields.precedence === 'string' ? fields.precedence.trim() : ''
    const precedence =
      rawPrecedence !== '' && /^\d+$/.test(rawPrecedence) ? Number(rawPrecedence) : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      enabled: coerceBoolean(fields.enabled, true),
      simulationMode: coerceBoolean(fields.simulationMode, false),
      action: rawAction,
      conditionsRaw:
        typeof fields.conditions === 'string' && fields.conditions.trim()
          ? fields.conditions.trim()
          : undefined,
      precedence,
    }
  })
}

export interface ParsedConditions {
  /** Managed condition keys, with any reserved keys removed. */
  conditions: Record<string, unknown>
  /** Reserved keys the user wrongly put inside the conditions JSON. */
  reservedKeysFound: string[]
  errors: string[]
}

/**
 * Parse and structurally validate the conditions JSON. It must be a JSON
 * object (not an array or primitive); reserved keys (name/enabled/action/…)
 * are stripped and reported so they cannot shadow the managed fields.
 */
export function parseConditions(raw: string | undefined): ParsedConditions {
  if (!raw) return { conditions: {}, reservedKeysFound: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      conditions: {},
      reservedKeysFound: [],
      errors: [`Conditions is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      conditions: {},
      reservedKeysFound: [],
      errors: ['Conditions must be a JSON object of condition keys (activity, sourceUser, sourceEndpoint, destination, trigger)'],
    }
  }

  const reserved = new Set<string>(RESERVED_RULE_KEYS)
  const conditions: Record<string, unknown> = {}
  const reservedKeysFound: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (reserved.has(key)) {
      reservedKeysFound.push(key)
      continue
    }
    conditions[key] = value
  }

  return { conditions, reservedKeysFound, errors: [] }
}

/**
 * Deterministic JSON serialization (object keys sorted recursively) so two
 * structurally-equal condition trees compare equal regardless of key order.
 * Used by the deploy diff and drift detection.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Identity Protection policy rule configurations: name presence and
 * uniqueness, action against the allowed set, well-formed conditions JSON, and
 * a numeric precedence hint.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIdpRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()
  const seenPrecedence = new Set<number>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // action — allowed set (unverified enum, see IDP_ACTIONS)
    if (!(IDP_ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({
        field: `${prefix}.action`,
        message: `Action must be one of: ${IDP_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }

    // conditions JSON
    const { conditions, reservedKeysFound, errors: conditionErrors } = parseConditions(spec.conditionsRaw)
    for (const message of conditionErrors) {
      errors.push({ field: `${prefix}.conditions`, message, code: 'invalid_conditions' })
    }
    if (reservedKeysFound.length > 0) {
      warnings.push({
        field: `${prefix}.conditions`,
        message: `Ignoring reserved key(s) in conditions JSON: ${reservedKeysFound.join(', ')} — these are managed by the fields above`,
        code: 'reserved_condition_keys',
      })
    }
    if (spec.conditionsRaw && conditionErrors.length === 0 && Object.keys(conditions).length === 0) {
      warnings.push({
        field: `${prefix}.conditions`,
        message: 'Conditions JSON has no usable keys — the rule will apply with no scoping conditions',
        code: 'empty_conditions',
      })
    }

    // precedence — optional numeric hint; flag duplicates so ordering is deterministic
    if (spec.precedence !== undefined) {
      if (seenPrecedence.has(spec.precedence)) {
        warnings.push({
          field: `${prefix}.precedence`,
          message: `Precedence ${spec.precedence} is used by more than one rule — deploy order between them is not guaranteed`,
          code: 'duplicate_precedence',
        })
      }
      seenPrecedence.add(spec.precedence)
    }

    // simulation-mode advisory: an enforcing action running only in simulation never acts
    if (spec.simulationMode && spec.enabled && (spec.action === 'DENY' || spec.action === 'MFA')) {
      warnings.push({
        field: `${prefix}.simulationMode`,
        message: `Rule is enabled with action "${spec.action}" but simulation mode is on — it will log instead of enforce`,
        code: 'simulation_no_enforce',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
