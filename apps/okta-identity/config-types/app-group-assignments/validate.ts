import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta App Group Assignment API constraints --------------------------------
//
// An app-group assignment binds a GROUP to an APPLICATION. Its logical identity
// is the (appId, groupId) PAIR — the same group can be assigned to many apps and
// an app can have many groups, so neither id alone identifies the assignment.
// Every endpoint is nested under the parent application and keyed by the group:
//   GET        /apps/{appId}/groups                — list the app's assignments
//   GET/PUT/DEL /apps/{appId}/groups/{groupId}     — read / assign / unassign
// PUT is an idempotent create-or-update (Okta has no separate create), DELETE
// unassigns. There is NO lifecycle and NO secret material on an assignment.
//
// The assignment `profile` carries app-specific attribute overrides for the
// group. Group-DERIVED app users (the members that flow into the app because of
// this assignment) are managed via the GROUP and its rules, not here — this
// config type only declares which (app, group) pairs are bound and their
// priority/profile.

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AppGroupAssignmentSpec {
  sectionName: string
  /** Parent Okta application id — half of the (appId, groupId) identity. */
  appId: string
  /** Okta group id — the other half of the identity; also the assignment's id. */
  groupId: string
  /**
   * Optional assignment priority. undefined when blank (Okta keeps/assigns its
   * own), NaN when present but not a finite number (validate rejects it).
   */
  priority?: number
  /**
   * Raw JSON string of the assignment `profile` — app-specific attribute
   * overrides for this group. Parsed to an object and sent as `profile`.
   */
  profileJson?: string
}

/**
 * Shape of an app-group assignment returned by GET /apps/{appId}/groups and
 * GET /apps/{appId}/groups/{groupId}. `id` equals the groupId. Carries an index
 * signature so server-managed keys are readable and the live object can be handed
 * to helpers typed as Record<string, unknown>.
 */
export interface LiveAppGroupAssignment {
  /** The group id — the assignment's id equals the assigned group's id. */
  id?: string
  priority?: number
  profile?: Record<string, unknown>
  lastUpdated?: string
  created?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy/drift (to build the API body).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes one (appId, groupId) assignment. */
export function extractAppGroupAssignmentSpecs(canvas: CanvasSnapshot): AppGroupAssignmentSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const profileJson =
      typeof fields.profileJson === 'string' && fields.profileJson.trim()
        ? fields.profileJson.trim()
        : undefined

    return {
      sectionName: section.name,
      appId: typeof fields.appId === 'string' ? fields.appId.trim() : '',
      groupId: typeof fields.groupId === 'string' ? fields.groupId.trim() : '',
      priority: toOptionalPriority(fields.priority),
      profileJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate app-group assignment configurations. Static only — NO network:
 *   - appId is required (the parent application the group is assigned to)
 *   - groupId is required (the group being assigned; also the assignment id)
 *   - the (appId, groupId) PAIR — the assignment's logical identity — is unique
 *     per canvas
 *   - priority, when set, is a non-negative integer
 *   - profileJson, when set, parses to a JSON OBJECT
 *
 * There is no upsert in the CRUD sense: deploy PUTs the assignment (idempotent).
 * Unmanaged assignments on the app are never pruned — this only manages the
 * (appId, groupId) pairs declared here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppGroupAssignmentSpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // appId — required (the parent application the group is assigned to)
    if (!spec.appId) {
      errors.push({
        field: `${prefix}.appId`,
        message: 'Application id is required — the Okta app the group is assigned to',
        code: 'required',
      })
    }

    // groupId — required (the group being assigned; also the assignment's id)
    if (!spec.groupId) {
      errors.push({
        field: `${prefix}.groupId`,
        message: 'Group id is required — the Okta group being assigned to the app',
        code: 'required',
      })
    }

    // priority — optional; when set it must be a non-negative integer.
    if (spec.priority !== undefined && !(Number.isInteger(spec.priority) && spec.priority >= 0)) {
      errors.push({
        field: `${prefix}.priority`,
        message: 'Priority must be a non-negative integer',
        code: 'invalid_priority',
      })
    }

    // profileJson — when set, must parse to a JSON object (attribute overrides).
    if (spec.profileJson && parseJsonObject(spec.profileJson) === null) {
      errors.push({
        field: `${prefix}.profileJson`,
        message:
          'Profile must be a valid JSON object of app-specific attribute overrides, e.g. {"role":"admin"}',
        code: 'invalid_profile',
      })
    }

    // (appId, groupId) PAIR is the assignment's logical identity — dedupe on it.
    if (spec.appId && spec.groupId) {
      const key = JSON.stringify([spec.appId, spec.groupId])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.groupId`,
          message: `Duplicate assignment of group "${spec.groupId}" to app "${spec.appId}" — each (appId, groupId) pair may only be declared once per canvas`,
          code: 'duplicate_assignment',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
