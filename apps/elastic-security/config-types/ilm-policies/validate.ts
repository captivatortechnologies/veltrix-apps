import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch ILM API constraints ---------------------------------------

/** ILM policy name length cap (kept generous; ES itself is lenient here). */
export const MAX_POLICY_NAME_LENGTH = 255

/**
 * Names beginning with `.` or `@` are the Elastic-managed / built-in convention
 * (e.g. `.deprecation-indexing-ilm-policy`, `@lifecycle`) — a config MUST NOT
 * author one, and deploy additionally refuses any LIVE policy carrying
 * `_meta.managed: true`.
 */
export function isProtectedPolicyName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('@')
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IlmPolicySpec {
  sectionName: string
  /** Policy name — the logical identity carried in the PUT/GET/DELETE path. */
  name: string
  /**
   * Raw policy-object JSON string: the value of the `policy` key, i.e.
   * {"phases":{...}, "_meta":{...}?}. deploy wraps it as { policy: parsed }.
   */
  policyJson?: string
}

/** One entry of GET /_ilm/policy[/{name}] → `{ "<name>": { version, modified_date, policy } }`. */
export interface LiveIlmPolicyEntry {
  version?: number
  modified_date?: string
  /** The policy object itself — {phases, _meta?}. This is what we author + diff. */
  policy?: Record<string, unknown>
}

/** The GET /_ilm/policy response is a map keyed by policy name. */
export type LiveIlmPolicyResponse = Record<string, LiveIlmPolicyEntry>

/** Each canvas section describes one ILM policy. */
export function extractIlmPolicySpecs(canvas: CanvasSnapshot): IlmPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const policyJson =
      typeof fields.policyJson === 'string' && fields.policyJson.trim()
        ? fields.policyJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      policyJson,
    }
  })
}

/**
 * Parse a raw policy string, returning the object or null when the string is
 * not a JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the { policy: … } body).
 */
export function parsePolicyObject(raw: string): Record<string, unknown> | null {
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

// --- Validate handler ---------------------------------------------------------

/**
 * Validate ILM policy configurations against Elasticsearch _ilm constraints:
 * a name is required and must NOT use the reserved managed prefixes (`.`/`@`),
 * the policy JSON must parse to an object, and the policy NAME — a policy's
 * logical identity — must be unique across the canvas.
 *
 * Static rules only — NO network. The live-managed backstop (refusing any live
 * policy with `_meta.managed: true`) is enforced in deploy, where the current
 * server state is available.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIlmPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, capped, and the logical identity.
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
      // Protected: never author an Elastic-managed / built-in policy.
      if (isProtectedPolicyName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name "${spec.name}" is reserved — names starting with "." or "@" are Elastic-managed and cannot be authored`,
          code: 'protected_policy',
        })
      }
    }

    // policyJson — required, and must parse as a JSON object.
    if (!spec.policyJson) {
      errors.push({
        field: `${prefix}.policyJson`,
        message: 'Policy JSON is required — provide the policy object, e.g. {"phases":{…}}',
        code: 'required',
      })
    } else {
      const parsed = parsePolicyObject(spec.policyJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.policyJson`,
          message:
            'Policy must be a valid JSON object, e.g. {"phases":{"hot":{…},"delete":{…}}} — deploy wraps it as {"policy": …}',
          code: 'invalid_policy',
        })
      } else if (!parsed.phases || typeof parsed.phases !== 'object' || Array.isArray(parsed.phases)) {
        // A usable ILM policy needs a `phases` object; warn rather than error so
        // an unusual-but-valid body can still be pushed.
        warnings.push({
          field: `${prefix}.policyJson`,
          message: 'Policy has no "phases" object — an ILM policy normally defines at least a hot/delete phase',
          code: 'missing_phases',
        })
      }
    }

    // Policy NAME is the logical identity — dedupe on it. Matched exactly (not
    // case-folded) so it agrees with the name-based live match in deploy / drift.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy name may only be declared once per canvas`,
          code: 'duplicate_policy',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
