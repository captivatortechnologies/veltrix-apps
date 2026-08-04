import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra PIM role-eligibility constraints ----------------------------------
//
// PIM is request-based: an eligibility is created/updated/removed by POSTing a
// unifiedRoleEligibilityScheduleRequest (action adminAssign / adminUpdate /
// adminRemove). The applied state is read from the derived
// roleEligibilitySchedules collection and matched by the tuple
// (principalId + roleDefinitionId + directoryScopeId). The eligibility window is
// scheduleInfo.expiration, whose `type` is noExpiration | afterDateTime |
// afterDuration (with endDateTime or duration respectively).

const ISO8601_DURATION_RE = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/

export const EXPIRATION_TYPES = ['noExpiration', 'afterDateTime', 'afterDuration'] as const
export type ExpirationType = (typeof EXPIRATION_TYPES)[number]

export interface EligibilitySpec {
  itemId?: string
  principalId: string
  roleDefinitionId: string
  directoryScopeId: string
  expirationType: ExpirationType
  endDateTime: string
  duration: string
  justification: string
  ticketNumber: string
  ticketSystem: string
}

/** scheduleInfo.expiration (requestSchedule.expiration / expirationPattern). */
export interface ExpirationPattern {
  type?: string
  endDateTime?: string | null
  duration?: string | null
}

/** requestSchedule — the eligibility window supplied to a schedule request. */
export interface RequestSchedule {
  startDateTime?: string | null
  expiration?: ExpirationPattern
}

/** A unifiedRoleEligibilitySchedule as returned by Graph (the applied state). */
export interface LiveEligibilitySchedule {
  id?: string
  principalId?: string
  roleDefinitionId?: string
  directoryScopeId?: string
  appScopeId?: string | null
  status?: string
  memberType?: string
  createdDateTime?: string
  modifiedDateTime?: string
  scheduleInfo?: RequestSchedule
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asExpirationType(v: unknown): ExpirationType {
  const s = asString(v)
  return (EXPIRATION_TYPES as readonly string[]).includes(s) ? (s as ExpirationType) : 'noExpiration'
}

/** Normalize a directory scope — empty means tenant-wide "/". */
export function normalizeScope(v: string): string {
  return v || '/'
}

/** Stable key for the (principal, role, scope) identity tuple. */
export function eligibilityKey(principalId: string, roleDefinitionId: string, directoryScopeId: string): string {
  return `${principalId.toLowerCase()}|${roleDefinitionId.toLowerCase()}|${normalizeScope(directoryScopeId).toLowerCase()}`
}

/** A short human label for an eligibility item, used in messages and diffs. */
export function eligibilityLabel(spec: Pick<EligibilitySpec, 'principalId' | 'roleDefinitionId' | 'directoryScopeId'>): string {
  return `${spec.roleDefinitionId} → ${spec.principalId} @ ${normalizeScope(spec.directoryScopeId)}`
}

/** The scheduleInfo.expiration the request should carry, from the spec. */
export function desiredExpiration(spec: EligibilitySpec): ExpirationPattern {
  if (spec.expirationType === 'afterDateTime') return { type: 'afterDateTime', endDateTime: spec.endDateTime }
  if (spec.expirationType === 'afterDuration') return { type: 'afterDuration', duration: spec.duration }
  return { type: 'noExpiration' }
}

/** Interpret a live expiration's effective type, defaulting a bare pattern to noExpiration. */
function liveExpirationType(exp: ExpirationPattern | undefined): string {
  if (exp?.type) return exp.type
  if (!exp?.endDateTime && !exp?.duration) return 'noExpiration'
  return ''
}

/** True when two ISO instants refer to the same moment (tolerant of formatting). */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb
  return a === b
}

/**
 * Compare the desired eligibility window against a live schedule. Returns a
 * describable diff (expected/actual) when they differ, or null when they match.
 */
export function expirationDiff(
  spec: EligibilitySpec,
  live: LiveEligibilitySchedule | undefined,
): { expected: string; actual: string } | null {
  const want = desiredExpiration(spec)
  const got = live?.scheduleInfo?.expiration
  const gotType = liveExpirationType(got)

  if (want.type !== gotType) {
    return { expected: String(want.type), actual: gotType || '(unknown)' }
  }
  if (want.type === 'afterDateTime') {
    const gotEnd = asString(got?.endDateTime ?? '')
    if (!sameInstant(spec.endDateTime, gotEnd)) {
      return { expected: `endDateTime=${spec.endDateTime}`, actual: `endDateTime=${gotEnd || '(none)'}` }
    }
  }
  if (want.type === 'afterDuration') {
    const gotDuration = asString(got?.duration ?? '')
    if (spec.duration !== gotDuration) {
      return { expected: `duration=${spec.duration}`, actual: `duration=${gotDuration || '(none)'}` }
    }
  }
  return null
}

export function extractEligibilitySpecs(canvas: CanvasSnapshot): EligibilitySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      principalId: asString(f.principalId),
      roleDefinitionId: asString(f.roleDefinitionId),
      directoryScopeId: normalizeScope(asString(f.directoryScopeId)),
      expirationType: asExpirationType(f.expirationType),
      endDateTime: asString(f.endDateTime),
      duration: asString(f.duration),
      justification: asString(f.justification),
      ticketNumber: asString(f.ticketNumber),
      ticketSystem: asString(f.ticketSystem),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractEligibilitySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // principalId / roleDefinitionId / directoryScopeId are now live-picker
    // fields whose stored value is either a Graph id/shaped-scope-string (the
    // normal path) or a hand-typed display name from a canvas saved before
    // the picker existed (still valid — resolved via a live displayName -> id
    // map at deploy time). Neither can be verified offline without a live
    // Graph call, so an unresolvable value surfaces as a clear deploy/drift
    // error instead of a local format error here.
    if (!spec.principalId) {
      errors.push({ field: `${prefix}.principalId`, message: 'Principal is required', code: 'required' })
    }

    if (!spec.roleDefinitionId) {
      errors.push({ field: `${prefix}.roleDefinitionId`, message: 'Role is required', code: 'required' })
    }

    if (!spec.justification) {
      errors.push({ field: `${prefix}.justification`, message: 'Justification is required — most PIM role policies mandate it', code: 'required' })
    }

    if (spec.expirationType === 'afterDateTime') {
      if (!spec.endDateTime) {
        errors.push({ field: `${prefix}.endDateTime`, message: 'End date/time is required when expiration is a specific date/time', code: 'end_required' })
      } else if (Number.isNaN(Date.parse(spec.endDateTime))) {
        errors.push({ field: `${prefix}.endDateTime`, message: 'End date/time must be an ISO 8601 instant (e.g. 2026-12-31T00:00:00Z)', code: 'invalid_end' })
      }
    }
    if (spec.expirationType === 'afterDuration') {
      if (!spec.duration) {
        errors.push({ field: `${prefix}.duration`, message: 'Duration is required when expiration is a fixed duration', code: 'duration_required' })
      } else if (!ISO8601_DURATION_RE.test(spec.duration)) {
        errors.push({ field: `${prefix}.duration`, message: 'Duration must be an ISO 8601 duration (e.g. P365D)', code: 'invalid_duration' })
      }
    }

    if (spec.principalId && spec.roleDefinitionId) {
      const key = eligibilityKey(spec.principalId, spec.roleDefinitionId, spec.directoryScopeId)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.roleDefinitionId`,
          message: `Duplicate eligibility "${eligibilityLabel(spec)}" — each principal/role/scope tuple may only be declared once per canvas`,
          code: 'duplicate_eligibility',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
