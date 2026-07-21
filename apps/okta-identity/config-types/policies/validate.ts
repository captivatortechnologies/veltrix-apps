import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'

// --- Okta Policies API constraints -------------------------------------------

/** Upper bound on live group-existence checks per validate, to bound latency. */
export const MAX_LIVE_GROUP_CHECKS = 50

/** The three policy types this config type manages (canvas select values). */
export const POLICY_TYPES = ['OKTA_SIGN_ON', 'PASSWORD', 'MFA_ENROLL'] as const
export type PolicyType = (typeof POLICY_TYPES)[number]

/** A policy is ACTIVE or INACTIVE; status is changed via the lifecycle endpoint. */
export const POLICY_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Reasonable cap on the policy name (Okta console limit). */
export const MAX_POLICY_NAME_LENGTH = 255

/**
 * The Okta default policy per type is literally named "Default Policy" and is
 * system-managed (system:true). validate cannot see a live policy's `system`
 * flag, so it statically rejects this reserved name; deploy adds the live guard
 * (never DELETE a system:true policy).
 */
export const RESERVED_POLICY_NAME = 'Default Policy'

/**
 * Server-managed read-only fields to strip from a live policy/rule body before
 * a PUT (restore) or a drift comparison. `status` is handled separately via the
 * activate/deactivate lifecycle, so it is stripped too.
 */
export const POLICY_READONLY_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'system',
  '_links',
  '_embedded',
  'status',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PolicySpec {
  sectionName: string
  /** Policy type — OKTA_SIGN_ON | PASSWORD | MFA_ENROLL; part of the identity. */
  type: string
  /** Policy name — the other half of the (type, name) logical identity. */
  name: string
  description?: string
  /** Desired status, '' when the field is blank (deploy defaults it to ACTIVE). */
  status: string
  /** Okta group IDs for people.groups.include; empty = applies to all users. */
  groupIncludeIds: string[]
  /** Raw per-type settings JSON string; blank/omitted (and always for OKTA_SIGN_ON). */
  settingsJson?: string
  /** Raw rules JSON string (a JSON array of rule objects); blank = skip rules. */
  rulesJson?: string
}

/** Shape of a policy returned by GET /policies?type={TYPE} and GET /policies/{id}. */
export interface LivePolicy {
  id?: string
  type?: string
  name?: string
  description?: string
  status?: string
  priority?: number
  system?: boolean
  conditions?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/** Shape of a rule returned by GET /policies/{id}/rules. */
export interface LiveRule {
  id?: string
  name?: string
  type?: string
  status?: string
  priority?: number
  system?: boolean
  conditions?: Record<string, unknown>
  actions?: Record<string, unknown>
}

/** Canvas list fields (tags) arrive as arrays, or comma/newline text. */
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

/** Each canvas section describes one Okta policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined
    const rulesJson =
      typeof fields.rulesJson === 'string' && fields.rulesJson.trim()
        ? fields.rulesJson.trim()
        : undefined

    return {
      sectionName: section.name,
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : '',
      groupIncludeIds: toStringList(fields.groupIncludeIds),
      settingsJson,
      rulesJson,
    }
  })
}

/**
 * Parse a raw settings string, returning the object or null when the string is
 * not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 */
export function parseSettingsObject(raw: string): Record<string, unknown> | null {
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
 * Parse a raw rules string, returning the array or null when the string is not
 * a JSON ARRAY. Elements are NOT validated here — callers check each element is
 * an object with a `name`.
 */
export function parseRulesArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/** A rule object's `name` (trimmed), or '' when absent/blank. */
export function ruleName(rule: unknown): string {
  if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
    const name = (rule as Record<string, unknown>).name
    return typeof name === 'string' ? name.trim() : ''
  }
  return ''
}

/** Build the policy `conditions` from the modelled group scoping, or undefined. */
export function buildConditions(groupIncludeIds: string[]): Record<string, unknown> | undefined {
  if (!groupIncludeIds || groupIncludeIds.length === 0) return undefined
  return { people: { groups: { include: groupIncludeIds } } }
}

/** Copy an object without the server-managed read-only fields (+ any extras). */
export function stripReadOnly(
  obj: Record<string, unknown>,
  extra: readonly string[] = [],
): Record<string, unknown> {
  const drop = new Set<string>([...POLICY_READONLY_FIELDS, ...extra])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!drop.has(key)) out[key] = value
  }
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate policy configurations against the Okta policy model:
 *   - type is required and must be one of the three managed types
 *   - name is required, capped, and must not be the reserved default name
 *   - status, when set, is ACTIVE or INACTIVE
 *   - settingsJson, when set, is a JSON OBJECT (OKTA_SIGN_ON should have none)
 *   - rulesJson, when set, is a JSON ARRAY of objects each with a unique name
 *   - the (type, name) PAIR — a policy's logical identity — is unique per canvas
 *
 * Static rules only — NO network. It cannot know a live policy's `system` flag,
 * so the "never modify/delete a system policy" guard lives in deploy; here it
 * rejects only the reserved default-policy NAME.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // type — required, one of the three managed types (part of the identity)
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Policy type is required', code: 'required' })
    } else if (!(POLICY_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Policy type must be one of ${POLICY_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // name — required, <= 255 chars, and not the reserved default-policy name
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
      if (spec.name.toLowerCase() === RESERVED_POLICY_NAME.toLowerCase()) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${RESERVED_POLICY_NAME}" is the reserved Okta default policy name (system-managed) — choose another name`,
          code: 'reserved_policy',
        })
      }
    }

    // status — optional on the canvas (defaults to ACTIVE at deploy); when set
    // it must be ACTIVE or INACTIVE.
    if (spec.status && !(POLICY_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of ${POLICY_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // settingsJson — optional, and must parse to a JSON object when set.
    // OKTA_SIGN_ON has no settings; flag (warning) that any provided settings are
    // ignored so the author is not surprised.
    if (spec.settingsJson) {
      if (parseSettingsObject(spec.settingsJson) === null) {
        errors.push({
          field: `${prefix}.settingsJson`,
          message:
            'Settings must be a valid JSON object, e.g. {"password":{"complexity":{"minLength":12}}} — leave blank for OKTA_SIGN_ON',
          code: 'invalid_settings',
        })
      } else if (spec.type === 'OKTA_SIGN_ON') {
        warnings.push({
          field: `${prefix}.settingsJson`,
          message:
            'OKTA_SIGN_ON policies have no settings (session/MFA behaviour lives in the rules) — these settings will be ignored on deploy',
          code: 'settings_ignored',
        })
      }
    }

    // rulesJson — optional; when set it must parse to a JSON ARRAY of objects,
    // each with a unique non-empty name (rules are reconciled by name).
    if (spec.rulesJson) {
      const rules = parseRulesArray(spec.rulesJson)
      if (rules === null) {
        errors.push({
          field: `${prefix}.rulesJson`,
          message:
            'Rules must be a valid JSON array of rule objects, e.g. [{"name":"Require MFA","actions":{…}}] — leave blank to skip rule reconciliation',
          code: 'invalid_rules',
        })
      } else {
        const seenRuleNames = new Set<string>()
        rules.forEach((rule, index) => {
          if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            errors.push({
              field: `${prefix}.rulesJson[${index}]`,
              message: 'Each rule must be a JSON object',
              code: 'invalid_rule',
            })
            return
          }
          const rName = ruleName(rule)
          if (!rName) {
            errors.push({
              field: `${prefix}.rulesJson[${index}]`,
              message: 'Each rule must have a non-empty "name" (rules are reconciled by name)',
              code: 'rule_name_required',
            })
            return
          }
          if (seenRuleNames.has(rName)) {
            errors.push({
              field: `${prefix}.rulesJson[${index}]`,
              message: `Duplicate rule name "${rName}" — each rule name may only appear once in a policy`,
              code: 'duplicate_rule',
            })
          }
          seenRuleNames.add(rName)
        })
      }
    }

    // (type, name) PAIR is the policy's logical identity — dedupe on it. Matched
    // exactly (not case-folded) to agree with the (type, name) live match in
    // deploy / drift. A JSON-array key keeps the two halves unambiguous.
    if (spec.type && spec.name) {
      const key = JSON.stringify([spec.type, spec.name])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.type}:${spec.name}" — each (type, name) pair may only be declared once per canvas`,
          code: 'duplicate_policy',
        })
      }
      seenPairs.add(key)
    }
  }

  // Live pre-validation: when a connection is available (validate now receives the
  // resolved credential + component best-effort), verify every referenced Scoped
  // Group ID actually exists in the target Okta org — so a bad id fails cleanly at
  // Validate instead of mid-deploy. Skipped entirely when validate runs without a
  // connection (static-only). A transient (non-404) API error never false-flags an
  // id, and total checks are capped to bound latency.
  if (ctx.credential && ctx.component?.hostname) {
    const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
    if (!('error' in built)) {
      const { client } = built
      const existence = new Map<string, boolean>()
      let checks = 0
      for (const spec of specs) {
        for (const gid of spec.groupIncludeIds) {
          if (checks >= MAX_LIVE_GROUP_CHECKS) break
          let exists = existence.get(gid)
          if (exists === undefined) {
            checks++
            const res = await client.request('GET', `/groups/${encodeURIComponent(gid)}`)
            // 404 => truly missing. Any other non-ok (401/403/5xx) is treated as
            // "unknown" and NOT flagged, so a token/permission blip can't produce
            // false validation errors.
            exists = res.status !== 404
            existence.set(gid, exists)
          }
          if (exists === false) {
            errors.push({
              field: `${spec.sectionName}.groupIncludeIds`,
              message: `Scoped group "${gid}" was not found in this Okta org (people.groups.include)`,
              code: 'group_not_found',
            })
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
