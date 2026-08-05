import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// PingOne Sign-On Policies + Sign-On Policy Actions - shared spec/validation.
//
// Verified against Ping's own generated OpenAPI-derived SDK (see
// https://apidocs.pingidentity.com/pingone/platform/v1/api/#sign-on-policies
// and #sign-on-policy-actions).
//
// A policy's identity is its `name` (unique in the environment) - deploy lists
// /signOnPolicies and matches by name. Its ordered actions are a separate
// sub-resource (GET/POST /signOnPolicies/{id}/actions, GET/PUT/DELETE
// /actions/{actionId}) that carries NO name field, so - unlike Okta's
// name-reconciled policy rules - each action is matched by its required,
// policy-unique `priority` integer instead (PingOne evaluates lower priority
// first). The whole actions array is authored as ONE JSON textarea
// (actionsJson) because an action is a discriminated union on `type` with
// deeply nested, type-specific and free-form fields (condition trees,
// discovery rules, profiling attributes) that would either lose fidelity or
// balloon into dozens of rarely-used flat inputs if modelled individually.
// =============================================================================

/** The six sign-on-action types this app models (PingOne EnumSignOnPolicyType). */
export const SUPPORTED_ACTION_TYPES = [
  'LOGIN',
  'MULTI_FACTOR_AUTHENTICATION',
  'IDENTIFIER_FIRST',
  'IDENTITY_PROVIDER',
  'AGREEMENT',
  'PROGRESSIVE_PROFILING',
] as const
export type SupportedActionType = (typeof SUPPORTED_ACTION_TYPES)[number]

/**
 * PingID workforce-only action types. Valid PingOne enum values, but they
 * require the separate PingID product and are out of scope for this app -
 * recognised here only so validate can give a specific, actionable error
 * instead of a generic "invalid type".
 */
const PINGID_ACTION_TYPES = new Set<string>([
  'PINGID_AUTHENTICATION',
  'PINGID_WINLOGIN_PASSWORDLESS_AUTHENTICATION',
])

/** Reasonable cap on the policy name (PingOne console/API limit). */
export const MAX_POLICY_NAME_LENGTH = 256

/**
 * Server-managed read-only fields on a sign-on policy - stripped before a PUT
 * (rollback restore) or a drift comparison.
 */
export const POLICY_READONLY_FIELDS = ['id', 'environment', 'createdAt', 'updatedAt', '_links'] as const

/**
 * Server-managed read-only fields on a sign-on-policy action - stripped
 * before a PUT (rollback restore) or a drift comparison.
 */
export const ACTION_READONLY_FIELDS = ['id', '_links', 'environment', 'signOnPolicy'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface PolicySpec {
  sectionName: string
  /** Stable canvas item id (survives renames); not currently used for matching
   *  live state - see canvas.yaml: a rename creates a new policy, matching the
   *  network-zones single-resource pattern this type otherwise follows. */
  itemId?: string
  /** Policy name - the logical identity deploy matches on. */
  name: string
  description?: string
  /** Whether this policy should be the environment's default. */
  default: boolean
  /** Raw actions JSON string (a JSON array of action objects); blank = skip. */
  actionsJson?: string
}

/** Shape of a policy returned by GET /signOnPolicies and GET /signOnPolicies/{id}. */
export interface LivePolicy {
  id?: string
  name?: string
  description?: string
  default?: boolean
  environment?: unknown
  createdAt?: string
  updatedAt?: string
  _links?: unknown
}

/**
 * Shape of an action returned by GET /signOnPolicies/{id}/actions. Carries an
 * index signature so the type-specific fields (deviceAuthenticationPolicy,
 * identityProvider, agreement, attributes, condition, ...) are readable without
 * a full discriminated-union model on the read side.
 */
export interface LiveAction {
  id?: string
  priority?: number
  type?: string
  environment?: unknown
  signOnPolicy?: unknown
  _links?: unknown
  [key: string]: unknown
}

/** Each canvas item describes one PingOne sign-on policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const actionsJson =
      typeof fields.actionsJson === 'string' && fields.actionsJson.trim()
        ? fields.actionsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      itemId: section.id,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      default: fields.default === true,
      actionsJson,
    }
  })
}

/**
 * Parse a raw actions string, returning the array or null when the string is
 * not a JSON ARRAY (a JSON object or primitive counts as invalid). Elements
 * are NOT validated here - callers check each element's priority/type/shape.
 */
export function parseActionsArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/** An action object's `priority` (a finite number), or null when absent/invalid. */
export function actionPriority(action: unknown): number | null {
  if (action && typeof action === 'object' && !Array.isArray(action)) {
    const priority = (action as Record<string, unknown>).priority
    return typeof priority === 'number' && Number.isFinite(priority) ? priority : null
  }
  return null
}

/** An action object's `type` (trimmed), or '' when absent/not a string. */
export function actionType(action: unknown): string {
  if (action && typeof action === 'object' && !Array.isArray(action)) {
    const type = (action as Record<string, unknown>).type
    return typeof type === 'string' ? type.trim() : ''
  }
  return ''
}

/**
 * Per-type required-field check for an action already known to be a JSON
 * object with a supported `type`. Returns an error message, or null when the
 * type's required fields are present. Shared by validate (static) and deploy
 * (fail loudly rather than send an incomplete body).
 */
export function checkActionRequiredFields(action: Record<string, unknown>): string | null {
  switch (actionType(action)) {
    case 'MULTI_FACTOR_AUTHENTICATION': {
      const policy = action.deviceAuthenticationPolicy as Record<string, unknown> | undefined
      if (!policy || typeof policy.id !== 'string' || !policy.id.trim()) {
        return 'MULTI_FACTOR_AUTHENTICATION actions require "deviceAuthenticationPolicy":{"id":"<mfa-device-policy-id>"}'
      }
      return null
    }
    case 'IDENTITY_PROVIDER': {
      const idp = action.identityProvider as Record<string, unknown> | undefined
      if (!idp || typeof idp.id !== 'string' || !idp.id.trim()) {
        return 'IDENTITY_PROVIDER actions require "identityProvider":{"id":"<identity-provider-id>"}'
      }
      return null
    }
    case 'AGREEMENT': {
      const agreement = action.agreement as Record<string, unknown> | undefined
      if (!agreement || typeof agreement.id !== 'string' || !agreement.id.trim()) {
        return 'AGREEMENT actions require "agreement":{"id":"<agreement-id>"}'
      }
      return null
    }
    case 'PROGRESSIVE_PROFILING': {
      if (!Array.isArray(action.attributes) || action.attributes.length === 0) {
        return 'PROGRESSIVE_PROFILING actions require a non-empty "attributes" array, e.g. [{"name":"name.given","required":true}]'
      }
      if (typeof action.promptText !== 'string' || !action.promptText.trim()) {
        return 'PROGRESSIVE_PROFILING actions require "promptText"'
      }
      if (typeof action.preventMultiplePromptsPerFlow !== 'boolean') {
        return 'PROGRESSIVE_PROFILING actions require "preventMultiplePromptsPerFlow" (true or false)'
      }
      if (typeof action.promptIntervalSeconds !== 'number' || !Number.isFinite(action.promptIntervalSeconds)) {
        return 'PROGRESSIVE_PROFILING actions require a numeric "promptIntervalSeconds"'
      }
      return null
    }
    default:
      // LOGIN and IDENTIFIER_FIRST have no strictly-required fields beyond
      // priority/type - recovery/registration/discoveryRules are optional.
      return null
  }
}

/** Copy an object without its server-managed read-only fields. */
export function stripReadOnly(
  obj: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const drop = new Set<string>(fields)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!drop.has(key)) out[key] = value
  }
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate sign-on-policy configurations against the PingOne policy + action
 * model. Static rules only - no network:
 *   - name is required, <= 256 chars, and unique per canvas
 *   - actionsJson, when present, must parse to a JSON ARRAY (not an object or
 *     primitive), where every element:
 *       - is a JSON object
 *       - has a numeric "priority", unique WITHIN this policy's array
 *       - has a "type" from the 6 supported values (the two PingID workforce
 *         types are recognised and rejected with a specific message)
 *       - carries the required fields for its type (see checkActionRequiredFields)
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
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name - required, <= 256 chars, unique per canvas (case-insensitive; the
    // live match in deploy/drift is exact, but a case-only clash is still
    // almost certainly a typo worth flagging).
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
          message: `Duplicate policy name "${spec.name}" - each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // actionsJson - optional; when set it must parse to a JSON ARRAY of
    // objects, each with a unique numeric priority and a supported type
    // carrying its required fields.
    if (spec.actionsJson) {
      const actions = parseActionsArray(spec.actionsJson)
      if (actions === null) {
        errors.push({
          field: `${prefix}.actionsJson`,
          message:
            'Actions must be a valid JSON array of action objects, e.g. [{"priority":1,"type":"LOGIN"}] - a JSON object or primitive is not accepted',
          code: 'invalid_actions',
        })
      } else {
        const seenPriorities = new Set<number>()
        actions.forEach((action, index) => {
          const itemField = `${prefix}.actionsJson[${index}]`

          if (!action || typeof action !== 'object' || Array.isArray(action)) {
            errors.push({ field: itemField, message: 'Each action must be a JSON object', code: 'invalid_action' })
            return
          }
          const record = action as Record<string, unknown>

          const priority = actionPriority(record)
          if (priority === null) {
            errors.push({
              field: itemField,
              message: 'Each action requires a numeric "priority" (the reconciliation key within this policy)',
              code: 'priority_required',
            })
          } else if (seenPriorities.has(priority)) {
            errors.push({
              field: itemField,
              message: `Duplicate priority ${priority} - two actions in the same policy cannot share a priority`,
              code: 'duplicate_priority',
            })
          } else {
            seenPriorities.add(priority)
          }

          const type = actionType(record)
          if (!type) {
            errors.push({ field: `${itemField}.type`, message: 'Each action requires a "type"', code: 'type_required' })
          } else if (PINGID_ACTION_TYPES.has(type)) {
            errors.push({
              field: `${itemField}.type`,
              message: `"${type}" requires the separate PingID workforce product and is not supported by this app - supported types are ${SUPPORTED_ACTION_TYPES.join(', ')}`,
              code: 'unsupported_pingid_type',
            })
          } else if (!(SUPPORTED_ACTION_TYPES as readonly string[]).includes(type)) {
            errors.push({
              field: `${itemField}.type`,
              message: `Action type must be one of: ${SUPPORTED_ACTION_TYPES.join(', ')}`,
              code: 'invalid_action_type',
            })
          } else {
            const problem = checkActionRequiredFields(record)
            if (problem) {
              errors.push({ field: itemField, message: problem, code: 'missing_action_field' })
            }
          }
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
