import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Access-Control v3 Permissions constraints ------------------------
//
// A permission grants a set of SUBJECTS (users/groups, or everyone) a set of
// ACTIONS over a set of OBJECTS (tags, or all assets). The action set is not
// free-form: the object type dictates which actions are meaningful. Tenable
// rejects an incompatible pairing, so we enforce it statically here.
//
//   Tag       → CanUse | CanEdit     (use/edit a tag)
//   AllAssets → CanView | CanScan    (view/scan every asset)
//
// Object/subject types whose name begins with "All" are COLLECTIVE (AllAssets,
// AllUsers) and carry no uuid; every other type (Tag, User, UserGroup, …)
// references a specific record and therefore requires a uuid.

/** Which actions each known object type permits. Drives the pairing check. */
export const OBJECT_ACTION_RULES: Record<string, string[]> = {
  Tag: ['CanUse', 'CanEdit'],
  AllAssets: ['CanView', 'CanScan'],
}

/** A permission name is capped at 255 chars in the Tenable console. */
export const MAX_PERMISSION_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface PermissionSpec {
  sectionName: string
  /** Human name — the permission's logical identity (matched to permission_uuid). */
  name: string
  /** Action strings, e.g. ["CanUse"] — read from the `actions` tags field. */
  actions: string[]
  /** Raw JSON string for the objects array (a JSON array of {type, uuid?}). */
  objectsJson?: string
  /** Raw JSON string for the subjects array (a JSON array of {type, uuid?}). */
  subjectsJson?: string
}

/** Shape of a permission returned by GET /api/v3/access-control/permissions. */
export interface LivePermission {
  permission_uuid?: string
  name?: string
  actions?: string[]
  objects?: Array<Record<string, unknown>>
  subjects?: Array<Record<string, unknown>>
}

/** Each canvas section describes one access-control permission. */
export function extractPermissionSpecs(canvas: CanvasSnapshot): PermissionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const objectsJson =
      typeof fields.objectsJson === 'string' && fields.objectsJson.trim()
        ? fields.objectsJson.trim()
        : undefined
    const subjectsJson =
      typeof fields.subjectsJson === 'string' && fields.subjectsJson.trim()
        ? fields.subjectsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      actions: toStringList(fields.actions),
      objectsJson,
      subjectsJson,
    }
  })
}

/**
 * Normalize a `tags` field into a clean string list. The canvas delivers a tags
 * field as either an array of strings or a comma/newline-separated string.
 */
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
 * Parse a raw string, returning the parsed ARRAY or null when the string is not
 * a JSON array (a JSON object or primitive counts as invalid). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseJsonArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/** True for a non-null, non-array object (a JSON object element). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Collective types (AllAssets, AllUsers, …) carry no uuid; specific ones do. */
function requiresUuid(type: string): boolean {
  return !type.startsWith('All')
}

/**
 * Validate one objects/subjects array: every element must be a JSON object with
 * a non-empty string `type`, and a specific (non-"All*") type must carry a
 * string uuid. Returns the distinct set of `type` values seen (for pairing).
 * Pushes an error under `code` for every problem found.
 */
function validateEntityArray(
  entries: unknown[],
  field: string,
  noun: string,
  code: string,
  errors: ValidationResult['errors'],
): string[] {
  const types = new Set<string>()
  if (entries.length === 0) {
    errors.push({ field, message: `At least one ${noun} is required`, code })
    return []
  }
  entries.forEach((el, i) => {
    if (!isPlainObject(el)) {
      errors.push({ field, message: `${noun} #${i + 1} must be a JSON object with a "type"`, code })
      return
    }
    const type = typeof el.type === 'string' ? el.type.trim() : ''
    if (!type) {
      errors.push({ field, message: `${noun} #${i + 1} is missing a "type"`, code })
      return
    }
    if (requiresUuid(type) && typeof el.uuid !== 'string') {
      errors.push({
        field,
        message: `${noun} #${i + 1} of type "${type}" requires a "uuid" (only collective types like AllAssets/AllUsers omit it)`,
        code,
      })
    }
    types.add(type)
  })
  return [...types]
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate access-control permissions against the Tenable Access-Control v3
 * constraints: a name and at least one action are required; objects and
 * subjects must each parse as a JSON array of typed entities; the action set
 * must be COMPATIBLE with every object type (Tag → CanUse|CanEdit,
 * AllAssets → CanView|CanScan); and the name — a permission's logical identity —
 * must be unique across the canvas. No network calls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPermissionSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — the logical identity, matched to a permission_uuid on deploy
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Permission name is required', code: 'required' })
    } else if (spec.name.length > MAX_PERMISSION_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Permission name must be ${MAX_PERMISSION_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // actions — at least one required
    if (spec.actions.length === 0) {
      errors.push({
        field: `${prefix}.actions`,
        message: 'At least one action is required (e.g. CanView, CanScan, CanUse, CanEdit)',
        code: 'required',
      })
    }

    // objects — required; must parse as a JSON array of typed entities
    let objectTypes: string[] = []
    if (!spec.objectsJson) {
      errors.push({ field: `${prefix}.objectsJson`, message: 'Objects are required', code: 'required' })
    } else {
      const parsed = parseJsonArray(spec.objectsJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.objectsJson`,
          message:
            'Objects must be a JSON array, e.g. [{"type":"Tag","uuid":"…"}] or [{"type":"AllAssets"}]',
          code: 'invalid_objects',
        })
      } else {
        objectTypes = validateEntityArray(parsed, `${prefix}.objectsJson`, 'object', 'invalid_objects', errors)
      }
    }

    // subjects — required; must parse as a JSON array of typed entities
    if (!spec.subjectsJson) {
      errors.push({ field: `${prefix}.subjectsJson`, message: 'Subjects are required', code: 'required' })
    } else {
      const parsed = parseJsonArray(spec.subjectsJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.subjectsJson`,
          message:
            'Subjects must be a JSON array, e.g. [{"type":"User","uuid":"…"}] or [{"type":"AllUsers"}]',
          code: 'invalid_subjects',
        })
      } else {
        validateEntityArray(parsed, `${prefix}.subjectsJson`, 'subject', 'invalid_subjects', errors)
      }
    }

    // action↔object pairing — every action must be valid for every known object
    // type present. Tenable rejects an incompatible pairing, so reject it here.
    if (spec.actions.length > 0) {
      for (const type of objectTypes) {
        const allowed = OBJECT_ACTION_RULES[type]
        if (!allowed) continue // no rule for this object type — cannot pair-check
        for (const action of spec.actions) {
          if (!allowed.includes(action)) {
            errors.push({
              field: `${prefix}.actions`,
              message: `Action "${action}" is not valid for object type "${type}" — ${type} permits only: ${allowed.join(', ')}`,
              code: 'invalid_pairing',
            })
          }
        }
      }
    }

    // name is the logical identity — dedupe on it (matched exactly, as Tenable
    // stores it literally and matches by name → permission_uuid on deploy).
    if (spec.name) {
      const key = spec.name
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate permission "${spec.name}" — each permission name may only be declared once per canvas`,
          code: 'duplicate_permission',
        })
      }
      seenNames.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
