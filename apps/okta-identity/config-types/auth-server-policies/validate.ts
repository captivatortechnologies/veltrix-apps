import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Authorization-Server Policy API constraints ------------------------
//
// An authorization-server policy is a CHILD of a custom authorization server:
// every endpoint lives under /authorizationServers/{authServerId}/policies, so a
// policy's logical identity is the (authServerId, name) PAIR. The parent
// authServerId is a canvas field (e.g. 'default' or 'aus1abc...').

/** The only policy type a custom authorization server accepts. */
export const POLICY_TYPE = 'OAUTH_AUTHORIZATION_POLICY'

/** The only rule type an authorization-server policy accepts. */
export const RULE_TYPE = 'RESOURCE_ACCESS'

/** A policy/rule is ACTIVE or INACTIVE; status is changed via the lifecycle endpoint. */
export const POLICY_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Reasonable cap on the policy name (Okta console limit). */
export const MAX_POLICY_NAME_LENGTH = 255

/** Default client scoping — applies the policy to every client of the auth server. */
export const DEFAULT_CLIENT_INCLUDE = ['ALL_CLIENTS'] as const

/**
 * The built-in "Default Policy" per authorization server is system-managed
 * (system:true). It may be UPDATED in place, but never deleted/recreated — so
 * unlike a top-level policy its NAME is not statically rejected; validate warns,
 * and deploy/rollback add the live guard (never DELETE a system:true policy).
 */
export const SYSTEM_DEFAULT_POLICY_NAME = 'Default Policy'

/**
 * Server-managed read-only fields to strip from a live policy/rule body before a
 * PUT (restore) or when reusing it as a request body. `status` is handled
 * separately via the activate/deactivate lifecycle, so it is stripped too.
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

// --- Path helpers (child endpoints) ------------------------------------------

/** `/authorizationServers/{authServerId}/policies` — the collection endpoint. */
export function policiesPath(authServerId: string): string {
  return `/authorizationServers/${encodeURIComponent(authServerId)}/policies`
}

/** `/authorizationServers/{authServerId}/policies/{policyId}/rules`. */
export function rulesPath(authServerId: string, policyId: string): string {
  return `${policiesPath(authServerId)}/${policyId}/rules`
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AuthServerPolicySpec {
  sectionName: string
  /** Parent authorization server id — half of the (authServerId, name) identity. */
  authServerId: string
  /** Policy name — the other half of the (authServerId, name) logical identity. */
  name: string
  description?: string
  /** Desired priority; undefined when blank, NaN when set to a non-number. */
  priority?: number
  /** Desired status, '' when the field is blank (deploy defaults it to ACTIVE). */
  status: string
  /** conditions.clients.include; empty = default ["ALL_CLIENTS"] at deploy time. */
  clientInclude: string[]
  /** Raw rules JSON string (a JSON array of rule objects); blank = skip rules. */
  rulesJson?: string
}

/** Shape of a policy returned by the authorizationServers/{id}/policies endpoints. */
export interface LiveAuthServerPolicy {
  id?: string
  type?: string
  name?: string
  description?: string
  status?: string
  priority?: number
  system?: boolean
  conditions?: Record<string, unknown>
}

/** Shape of a rule returned by .../policies/{id}/rules. */
export interface LiveAuthServerRule {
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

/**
 * Parse a canvas priority field. Returns undefined when blank/absent, NaN when
 * present but not a finite number (so validate can reject it), else the number.
 */
export function toOptionalPriority(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

/** Each canvas section describes one authorization-server policy. */
export function extractAuthServerPolicySpecs(canvas: CanvasSnapshot): AuthServerPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const rulesJson =
      typeof fields.rulesJson === 'string' && fields.rulesJson.trim()
        ? fields.rulesJson.trim()
        : undefined

    return {
      sectionName: section.name,
      authServerId: typeof fields.authServerId === 'string' ? fields.authServerId.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      priority: toOptionalPriority(fields.priority),
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : '',
      clientInclude: toStringList(fields.clientInclude),
      rulesJson,
    }
  })
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

/** A rule object's desired status (uppercased), defaulting to ACTIVE. */
export function ruleStatus(rule: unknown): string {
  if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
    const status = (rule as Record<string, unknown>).status
    if (typeof status === 'string' && status.trim()) return status.trim().toUpperCase()
  }
  return 'ACTIVE'
}

/** A rule object's declared `type`, or '' when absent — used to warn on non-RESOURCE_ACCESS. */
export function ruleType(rule: unknown): string {
  if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
    const type = (rule as Record<string, unknown>).type
    if (typeof type === 'string') return type.trim()
  }
  return ''
}

/** The client-include set to apply, defaulting to ["ALL_CLIENTS"] when unset. */
export function resolveClientInclude(clientInclude: string[]): string[] {
  return clientInclude.length ? clientInclude : [...DEFAULT_CLIENT_INCLUDE]
}

/** Build the policy `conditions` from the modelled client scoping (never empty). */
export function buildClientConditions(clientInclude: string[]): Record<string, unknown> {
  return { clients: { include: resolveClientInclude(clientInclude) } }
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
 * Validate authorization-server policy configurations:
 *   - authServerId is required (the parent auth server id)
 *   - name is required and capped
 *   - status, when set, is ACTIVE or INACTIVE
 *   - priority, when set, is a positive integer
 *   - rulesJson, when set, is a JSON ARRAY of objects each with a unique name;
 *     a rule that declares a type other than RESOURCE_ACCESS is warned (deploy
 *     forces the only valid rule type, RESOURCE_ACCESS)
 *   - the (authServerId, name) PAIR — a policy's logical identity — is unique
 *
 * Static rules only — NO network. It cannot know a live policy/rule's `system`
 * flag, so the "never DELETE a system object" guard lives in deploy/rollback;
 * here it only WARNS on the reserved default-policy name (which may be updated
 * in place).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuthServerPolicySpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // authServerId — required (part of the identity; the parent auth server).
    if (!spec.authServerId) {
      errors.push({
        field: `${prefix}.authServerId`,
        message: 'Authorization server id is required (e.g. "default" or an aus… id)',
        code: 'required',
      })
    }

    // name — required, <= 255 chars.
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    } else if (spec.name.toLowerCase() === SYSTEM_DEFAULT_POLICY_NAME.toLowerCase()) {
      warnings.push({
        field: `${prefix}.name`,
        message:
          `"${SYSTEM_DEFAULT_POLICY_NAME}" is the built-in system policy — it will be updated in place, ` +
          'never deleted or recreated',
        code: 'system_default_policy',
      })
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

    // priority — optional; when set it must be a positive integer.
    if (spec.priority !== undefined && !(Number.isInteger(spec.priority) && spec.priority >= 1)) {
      errors.push({
        field: `${prefix}.priority`,
        message: 'Priority must be a positive integer (1 or greater)',
        code: 'invalid_priority',
      })
    }

    // rulesJson — optional; when set it must parse to a JSON ARRAY of objects,
    // each with a unique non-empty name (rules are reconciled by name).
    if (spec.rulesJson) {
      const rules = parseRulesArray(spec.rulesJson)
      if (rules === null) {
        errors.push({
          field: `${prefix}.rulesJson`,
          message:
            'Rules must be a valid JSON array of rule objects, e.g. [{"name":"Default","actions":{"token":{"accessTokenLifetimeMinutes":60}}}] — leave blank to skip rule reconciliation',
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

          const rType = ruleType(rule)
          if (rType && rType !== RULE_TYPE) {
            warnings.push({
              field: `${prefix}.rulesJson[${index}]`,
              message: `Rule "${rName}" declares type "${rType}"; authorization-server policy rules must be ${RULE_TYPE} — it will be forced on deploy`,
              code: 'rule_type_forced',
            })
          }
        })
      }
    }

    // (authServerId, name) PAIR is the policy's logical identity — dedupe on it.
    // Matched exactly (not case-folded) to agree with the live match in deploy /
    // drift. A JSON-array key keeps the two halves unambiguous.
    if (spec.authServerId && spec.name) {
      const key = JSON.stringify([spec.authServerId, spec.name])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.authServerId}:${spec.name}" — each (authServerId, name) pair may only be declared once per canvas`,
          code: 'duplicate_policy',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
