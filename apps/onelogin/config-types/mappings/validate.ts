import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- OneLogin User Mappings API constraints --------------------------------------
// https://developers.onelogin.com/api-docs/2/user-mappings
//
// GET/POST       /api/2/mappings       - list (bare array) / create
// GET/PUT/DELETE /api/2/mappings/{id}  - read / update / delete
// PUT            /api/2/mappings/sort  - bulk reorder (requires EVERY mapping
//                                        id in the account, or a 422)
//
// A mapping's logical identity in this config type is its NAME - OneLogin has
// no upsert, so this app matches an existing mapping by name.

export interface MappingCondition {
  source: string
  operator: string
  value: string
}
export interface MappingAction {
  action: string
  value: string[]
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface MappingSpec {
  sectionName: string
  name: string
  enabled: boolean
  match: 'all' | 'any'
  conditionsJson: string
  actionsJson: string
}

/** Shape of a mapping returned by GET /api/2/mappings (list) and GET /api/2/mappings/{id}. */
export interface LiveMapping {
  id?: number
  name?: string
  match?: string
  enabled?: boolean
  position?: number
  conditions?: MappingCondition[]
  actions?: MappingAction[]
  [key: string]: unknown
}

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas item describes one OneLogin user mapping. */
export function extractMappingSpecs(canvas: CanvasSnapshot): MappingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      enabled: typeof fields.enabled === 'boolean' ? fields.enabled : true,
      match: fields.match === 'any' ? 'any' : 'all',
      conditionsJson: trimmedOrUndefined(fields.conditionsJson) ?? '',
      actionsJson: trimmedOrUndefined(fields.actionsJson) ?? '',
    }
  })
}

/** Parse a JSON string, returning the array or null when it is not a non-empty JSON array. */
export function parseNonEmptyArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (Array.isArray(parsed) && parsed.length > 0) return parsed
  return null
}

/** Validate one condition object's shape. */
export function isValidCondition(value: unknown): value is MappingCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  return typeof c.source === 'string' && c.source.trim().length > 0 && typeof c.operator === 'string' && c.operator.trim().length > 0
}

/** Validate one action object's shape. */
export function isValidAction(value: unknown): value is MappingAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const a = value as Record<string, unknown>
  return typeof a.action === 'string' && a.action.trim().length > 0 && Array.isArray(a.value)
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user mapping configurations against the OneLogin User Mappings
 * API. Static only:
 *   - name is required and unique across the canvas
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

  const specs = extractMappingSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Mapping name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate mapping "${spec.name}" - each mapping name may only be declared once per canvas`,
        code: 'duplicate_mapping',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.conditionsJson) {
      errors.push({ field: `${prefix}.conditionsJson`, message: 'Conditions are required', code: 'required' })
    } else {
      const conditions = parseNonEmptyArray(spec.conditionsJson)
      if (!conditions) {
        errors.push({
          field: `${prefix}.conditionsJson`,
          message: 'Conditions must be a non-empty JSON array, e.g. [{"source":"last_login","operator":">","value":"90"}]',
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
          message: 'Actions must be a non-empty JSON array, e.g. [{"action":"set_status","value":["2"]}]',
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
