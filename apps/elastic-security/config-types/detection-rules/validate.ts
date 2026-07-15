import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Detections API constraints ---------------------------------------

/** Rule name / rule_id length caps (Kibana Security app limits). */
export const MAX_RULE_ID_LENGTH = 255
export const MAX_RULE_NAME_LENGTH = 512

/**
 * Server-managed fields Kibana injects and never accepts on create/update.
 * driftDetect strips exactly these before diffing; deploy / rollback strip these
 * PLUS `version` (custom-rule version is create-only) when building a body.
 */
export const RULE_SERVER_FIELDS = [
  'id',
  'revision',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'execution_summary',
] as const

/**
 * Rule types whose primary detection input is a `query` string. Used for the
 * LIGHT validate check only — a warning, never an error, since the full
 * per-type schema is validated by Kibana on deploy.
 */
export const QUERY_RULE_TYPES = ['query', 'saved_query', 'eql', 'esql', 'threshold', 'new_terms', 'threat_match']

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RuleSpec {
  sectionName: string
  /** rule_id — the stable, user-defined logical identity we match live rules on. */
  ruleId: string
  /** Display name (forced onto the body over any name inside ruleJson). */
  name: string
  /** Whether the rule runs (forced onto the body over any enabled inside ruleJson). */
  enabled: boolean
  /**
   * Raw rule-body JSON string carrying the rest of the rule (type, query, index,
   * risk_score, severity, description, …). Absent/blank is rejected by validate.
   */
  ruleJson?: string
}

/**
 * Shape of a rule returned by GET /api/detection_engine/rules. Only the fields
 * the handlers reason about are named; the index signature keeps the (large,
 * per-type) remainder addressable for drift comparison.
 */
export interface LiveRule {
  id?: string
  rule_id?: string
  name?: string
  enabled?: boolean
  type?: string
  /** true for Elastic-shipped rules (legacy marker) — PROTECTED, never modified. */
  immutable?: boolean
  /** Newer prebuilt marker: rule_source.type === "external" ⇒ Elastic prebuilt. */
  rule_source?: { type?: string } | null
  version?: number
  revision?: number
  [key: string]: unknown
}

/** Coerce a checkbox value to a boolean, falling back to a default when unset. */
export function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Each canvas section describes one detection rule. */
export function extractRuleSpecs(canvas: CanvasSnapshot): RuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const ruleJson =
      typeof fields.ruleJson === 'string' && fields.ruleJson.trim() ? fields.ruleJson.trim() : undefined

    return {
      sectionName: section.name,
      ruleId: typeof fields.rule_id === 'string' ? fields.rule_id.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      enabled: toBool(fields.enabled, true),
      ruleJson,
    }
  })
}

/**
 * Parse a raw rule-body string, returning the object or null when the string is
 * not a JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseRuleObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/**
 * Is this rule an Elastic PREBUILT rule? Prebuilt rules are Elastic-managed and
 * MUST NOT be modified, replaced or deleted. Two markers cover old and new
 * Kibana versions: legacy `immutable === true`, and newer
 * `rule_source.type === "external"`. Works on both a live rule and an authored
 * ruleJson object (validate uses it to reject authoring such a marker).
 */
export function isPrebuiltRule(rule: Record<string, unknown> | null | undefined): boolean {
  if (!rule) return false
  if (rule.immutable === true) return true
  const source = rule.rule_source
  if (source && typeof source === 'object' && (source as { type?: unknown }).type === 'external') {
    return true
  }
  return false
}

/** Strip the server-managed fields Kibana never accepts on write. */
export function stripServerFields(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rule }
  for (const field of RULE_SERVER_FIELDS) delete out[field]
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate detection-rule configurations against Kibana Detections API
 * constraints. Static rules only — NO network:
 *   - rule_id and name are required (rule_id is the logical identity, capped 255)
 *   - the Definition JSON must parse to an object
 *   - a light, WARN-only check that a `type` is present and, for query-shaped
 *     types, a query field is present (Kibana validates the deep per-type schema)
 *   - PROTECTED: authoring a prebuilt marker (immutable / rule_source=external)
 *     is rejected — those are Elastic-managed rules this app never authors
 *   - rule_id — the logical identity — must be unique across the canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleSpecs(ctx.canvas)
  const seenRuleIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // rule_id — required, <= 255 chars, and the logical identity
    if (!spec.ruleId) {
      errors.push({ field: `${prefix}.rule_id`, message: 'rule_id is required', code: 'required' })
    } else if (spec.ruleId.length > MAX_RULE_ID_LENGTH) {
      errors.push({
        field: `${prefix}.rule_id`,
        message: `rule_id must be ${MAX_RULE_ID_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // name — required display name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else if (spec.name.length > MAX_RULE_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // ruleJson — required, and must parse as a JSON object.
    if (!spec.ruleJson) {
      errors.push({
        field: `${prefix}.ruleJson`,
        message: 'Rule Definition JSON is required — a detection rule needs a type and its query/definition',
        code: 'required',
      })
      continue
    }

    const ruleObj = parseRuleObject(spec.ruleJson)
    if (ruleObj === null) {
      errors.push({
        field: `${prefix}.ruleJson`,
        message:
          'Rule Definition must be a valid JSON object, e.g. {"type":"query","language":"kuery","query":"event.code:4688","risk_score":47,"severity":"medium"}',
        code: 'invalid_rule_json',
      })
    } else {
      // PROTECTED: refuse to author an Elastic prebuilt-rule marker. Prebuilt
      // rules are Elastic-managed; this app installs and updates CUSTOM rules only.
      if (isPrebuiltRule(ruleObj)) {
        errors.push({
          field: `${prefix}.ruleJson`,
          message:
            'This rule is marked as an Elastic prebuilt rule (immutable / rule_source.type="external"). ' +
            'Prebuilt rules are Elastic-managed and cannot be authored or modified here — remove the immutable/rule_source marker.',
          code: 'protected_rule',
        })
      }

      // LIGHT checks — warnings only; Kibana validates the deep per-type schema.
      const type = typeof ruleObj.type === 'string' ? ruleObj.type : ''
      if (!type) {
        warnings.push({
          field: `${prefix}.ruleJson`,
          message: 'Rule Definition has no "type" — Kibana requires one of query, eql, esql, threshold, machine_learning, threat_match, new_terms, saved_query',
          code: 'missing_type',
        })
      } else if (QUERY_RULE_TYPES.includes(type)) {
        const hasQuery =
          (typeof ruleObj.query === 'string' && ruleObj.query.trim().length > 0) ||
          typeof ruleObj.saved_id === 'string'
        if (!hasQuery) {
          warnings.push({
            field: `${prefix}.ruleJson`,
            message: `Rule type "${type}" usually needs a "query" (or "saved_id") — none found; Kibana will reject it if truly required`,
            code: 'missing_query',
          })
        }
      }

      // Nudge: version is create-only and stays 1 — it is stripped on deploy.
      if ('version' in ruleObj) {
        warnings.push({
          field: `${prefix}.ruleJson`,
          message: 'A "version" was set — it is ignored (custom-rule version is create-only and stays 1). Remove it.',
          code: 'version_ignored',
        })
      }
    }

    // rule_id is the logical identity — dedupe on it. Matched exactly
    // (case-sensitive) so it agrees with the rule_id match in deploy / drift.
    if (spec.ruleId) {
      if (seenRuleIds.has(spec.ruleId)) {
        errors.push({
          field: `${prefix}.rule_id`,
          message: `Duplicate rule_id "${spec.ruleId}" — each rule_id may only be declared once per canvas`,
          code: 'duplicate_rule',
        })
      }
      seenRuleIds.add(spec.ruleId)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
