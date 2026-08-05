import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isValidAction, isValidCondition, parseNonEmptyArray } from '../mappings/validate'

// --- OneLogin App Rules API constraints ------------------------------------------
// https://developers.onelogin.com/api-docs/2/app-rules
//
// GET/POST       /api/2/apps/{app_id}/rules       - list (bare array) / create
// GET/PUT/DELETE /api/2/apps/{app_id}/rules/{id}   - read / update / delete
// PUT            /api/2/apps/{app_id}/rules/sort   - bulk reorder (requires
//                                                    EVERY rule id for THAT
//                                                    APP, or a 422)
//
// A rule's logical identity in this config type is the PAIR (appId, name) -
// OneLogin has no upsert, so this app matches an existing rule by name
// WITHIN the target app's own rule list.

export interface AppRuleSpec {
  sectionName: string
  appId?: number
  name: string
  enabled: boolean
  match: 'all' | 'any'
  conditionsJson: string
  actionsJson: string
}

/** Shape of a rule returned by GET /api/2/apps/{app_id}/rules (list) and .../rules/{id}. */
export interface LiveAppRule {
  id?: number
  name?: string
  match?: string
  enabled?: boolean
  position?: number
  conditions?: unknown[]
  actions?: unknown[]
  [key: string]: unknown
}

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Each canvas item describes one OneLogin app rule, scoped to one app. */
export function extractAppRuleSpecs(canvas: CanvasSnapshot): AppRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      appId: numberOrUndefined(fields.appId),
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      enabled: typeof fields.enabled === 'boolean' ? fields.enabled : true,
      match: fields.match === 'any' ? 'any' : 'all',
      conditionsJson: trimmedOrUndefined(fields.conditionsJson) ?? '',
      actionsJson: trimmedOrUndefined(fields.actionsJson) ?? '',
    }
  })
}

/** The pair (appId, name) is a rule's logical identity - unique within the canvas. */
export function appRuleKey(appId: number | undefined, name: string): string {
  return `${appId ?? ''}::${name}`
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate app-rule configurations against the OneLogin App Rules API.
 * Static only - it never contacts OneLogin (the App picker is resolved live
 * by the platform's remote-select UI via options.ts, not here):
 *   - appId is required and must be a positive integer
 *   - name is required
 *   - the (appId, name) PAIR must be unique across the canvas
 *   - conditionsJson must parse to a non-empty JSON array of
 *     {source, operator, ...} objects
 *   - actionsJson must parse to a non-empty JSON array of {action, value[]}
 *     objects
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppRuleSpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (spec.appId === undefined) {
      errors.push({ field: `${prefix}.appId`, message: 'App is required', code: 'required' })
    } else if (!Number.isInteger(spec.appId) || spec.appId <= 0) {
      errors.push({ field: `${prefix}.appId`, message: 'App must resolve to a positive integer app id', code: 'invalid_app_id' })
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }

    if (spec.appId !== undefined && spec.name) {
      const key = appRuleKey(spec.appId, spec.name)
      if (seenKeys.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" for app ${spec.appId} - each (App, Name) pair may only be declared once per canvas`,
          code: 'duplicate_rule',
        })
      }
      seenKeys.add(key)
    }

    if (!spec.conditionsJson) {
      errors.push({ field: `${prefix}.conditionsJson`, message: 'Conditions are required', code: 'required' })
    } else {
      const conditions = parseNonEmptyArray(spec.conditionsJson)
      if (!conditions) {
        errors.push({
          field: `${prefix}.conditionsJson`,
          message: 'Conditions must be a non-empty JSON array, e.g. [{"source":"department","operator":"=","value":"Engineering"}]',
          code: 'invalid_conditions',
        })
      } else if (!conditions.every(isValidCondition)) {
        errors.push({
          field: `${prefix}.conditionsJson`,
          message: 'Every condition needs a non-empty "source" and "operator"',
          code: 'invalid_condition_shape',
        })
      }
    }

    if (!spec.actionsJson) {
      errors.push({ field: `${prefix}.actionsJson`, message: 'Actions are required', code: 'required' })
    } else {
      const actions = parseNonEmptyArray(spec.actionsJson)
      if (!actions) {
        errors.push({
          field: `${prefix}.actionsJson`,
          message: 'Actions must be a non-empty JSON array, e.g. [{"action":"set_role","value":["12345"]}]',
          code: 'invalid_actions',
        })
      } else if (!actions.every(isValidAction)) {
        errors.push({
          field: `${prefix}.actionsJson`,
          message: 'Every action needs a non-empty "action" name and a "value" array',
          code: 'invalid_action_shape',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
