import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'

// --- ACS maintenance-window change-freeze constraints ------------------------
//
// Splunk Cloud maintenance windows are SCHEDULED BY SPLUNK — the ACS API only
// lets customers VIEW them (GET /maintenance-windows/schedules). The one thing
// a customer controls is the change-freeze policy, held as a SINGLE object under
// /maintenance-windows/preferences: a `changeFreezes` record with a list of
// customerInitiatedFreezes (plus Splunk-managed splunkInitiatedFreezes) and a
// `recordVersion` for optimistic concurrency.
//
// This config type therefore manages ONE customer-initiated change freeze per
// stack — the canvas item — declared with UTC calendar dates and an appliesTo
// scope. Deploy upserts it into the live customerInitiatedFreezes list, PATCHing
// nothing else, and captures the prior list for rollback.
//
// Docs: help.splunk.com — "Manage maintenance windows for Splunk Cloud Platform"
//   GET /adminconfig/v2/maintenance-windows/schedules            (view only)
//   GET /adminconfig/v2/maintenance-windows/preferences          (view freezes)
//   PUT /adminconfig/v2/maintenance-windows/preferences          (create/update/delete freezes, 204)
// Change freeze object: { id?, startDate, endDate, appliesTo, reason, tickets? }
// Dates are "YYYY/MM/DD" (UTC); a freeze runs 00:00 UTC start → 23:59 UTC end.

/** ACS endpoint paths (relative to /{stack}/adminconfig/v2). */
export const PREFERENCES_PATH = '/maintenance-windows/preferences'
export const SCHEDULES_PATH = '/maintenance-windows/schedules'

/** The only two `appliesTo` scopes ACS accepts for a change freeze. */
export const APPLIES_TO_SPLUNK_ONLY = 'Splunk Initiated Changes Only'
export const APPLIES_TO_CUSTOMER_AND_SPLUNK = 'Customer and Splunk Initiated Changes'
export const APPLIES_TO_VALUES = [APPLIES_TO_SPLUNK_ONLY, APPLIES_TO_CUSTOMER_AND_SPLUNK] as const
export type AppliesTo = (typeof APPLIES_TO_VALUES)[number]

/** Change-freeze dates are UTC calendar dates in `YYYY/MM/DD` form. */
export const FREEZE_DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/
/** A freeze longer than this is legal but worth a "confirm this is intentional" nudge. */
export const LONG_FREEZE_WARNING_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

/** Validate `YYYY/MM/DD` and confirm it is a real calendar date (UTC). */
export function isValidFreezeDate(value: string): boolean {
  if (!FREEZE_DATE_RE.test(value)) return false
  const [y, m, d] = value.split('/').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Parse `YYYY/MM/DD` to a UTC-midnight epoch, or null when invalid. */
export function parseFreezeDate(value: string): number | null {
  if (!isValidFreezeDate(value)) return null
  const [y, m, d] = value.split('/').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** UTC midnight for "today", used to flag change freezes whose start is in the past. */
function todayUtcMs(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ------

export interface MaintenanceWindowSpec {
  sectionName: string
  /** Change-freeze start date, `YYYY/MM/DD` (UTC). */
  startDate: string
  /** Change-freeze end date, `YYYY/MM/DD` (UTC). */
  endDate: string
  /** One of {@link APPLIES_TO_VALUES}. */
  appliesTo: string
  reason: string
  /** Optional related tickets recorded with the freeze. */
  tickets: string[]
}

/**
 * The change freeze is a SINGLE object per stack, so the canvas declares exactly
 * one item — this reads the first (and only) one. Extra items are rejected by
 * validate rather than silently deployed.
 */
export function extractMaintenanceWindowSpec(canvas: CanvasSnapshot): MaintenanceWindowSpec {
  const section = (canvas.sections ?? [])[0]
  const fields = section?.fields ?? {}
  return {
    sectionName: section?.name ?? 'change-freeze',
    startDate: typeof fields.startDate === 'string' ? fields.startDate.trim() : '',
    endDate: typeof fields.endDate === 'string' ? fields.endDate.trim() : '',
    appliesTo: typeof fields.appliesTo === 'string' ? fields.appliesTo.trim() : '',
    reason: typeof fields.reason === 'string' ? fields.reason.trim() : '',
    tickets: splitList(fields.tickets),
  }
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate the declared change freeze against ACS constraints: a single item,
 * valid UTC `YYYY/MM/DD` dates in order, a supported `appliesTo` scope, and a
 * reason. Warns on past-dated, very long, or self-affecting freezes.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message:
        'Only one change freeze may be declared per stack — the ACS maintenance-window preference is a single object',
      code: 'single_item',
    })
  }

  const spec = extractMaintenanceWindowSpec(ctx.canvas)
  const prefix = spec.sectionName

  // Start date
  let startMs: number | null = null
  if (!spec.startDate) {
    errors.push({ field: `${prefix}.startDate`, message: 'Start date is required', code: 'required' })
  } else if (!isValidFreezeDate(spec.startDate)) {
    errors.push({
      field: `${prefix}.startDate`,
      message: `"${spec.startDate}" is not a valid date — use YYYY/MM/DD (UTC)`,
      code: 'invalid_date',
    })
  } else {
    startMs = parseFreezeDate(spec.startDate)
  }

  // End date
  let endMs: number | null = null
  if (!spec.endDate) {
    errors.push({ field: `${prefix}.endDate`, message: 'End date is required', code: 'required' })
  } else if (!isValidFreezeDate(spec.endDate)) {
    errors.push({
      field: `${prefix}.endDate`,
      message: `"${spec.endDate}" is not a valid date — use YYYY/MM/DD (UTC)`,
      code: 'invalid_date',
    })
  } else {
    endMs = parseFreezeDate(spec.endDate)
  }

  // Range: end must be on or after start
  if (startMs !== null && endMs !== null && endMs < startMs) {
    errors.push({
      field: `${prefix}.endDate`,
      message: `End date (${spec.endDate}) must be on or after start date (${spec.startDate})`,
      code: 'invalid_range',
    })
  }

  // Applies-to scope
  if (!spec.appliesTo) {
    errors.push({ field: `${prefix}.appliesTo`, message: 'Applies-to scope is required', code: 'required' })
  } else if (!(APPLIES_TO_VALUES as readonly string[]).includes(spec.appliesTo)) {
    errors.push({
      field: `${prefix}.appliesTo`,
      message: `"${spec.appliesTo}" is not a valid applies-to scope — use one of: ${APPLIES_TO_VALUES.join(', ')}`,
      code: 'invalid_applies_to',
    })
  } else if (spec.appliesTo === APPLIES_TO_CUSTOMER_AND_SPLUNK) {
    warnings.push({
      field: `${prefix}.appliesTo`,
      message:
        '"Customer and Splunk Initiated Changes" also blocks YOUR OWN deployments during the freeze window',
      code: 'freezes_customer_changes',
    })
  }

  // Reason (recorded on the ACS request for audit)
  if (!spec.reason) {
    errors.push({
      field: `${prefix}.reason`,
      message: 'A reason is required for the change freeze (recorded on the ACS request)',
      code: 'required',
    })
  }

  // Schedule-window warnings (non-blocking)
  if (startMs !== null && startMs < todayUtcMs()) {
    warnings.push({
      field: `${prefix}.startDate`,
      message: 'Start date is in the past — the change freeze may already be partially elapsed',
      code: 'past_start',
    })
  }
  if (startMs !== null && endMs !== null && endMs >= startMs) {
    const spanDays = Math.floor((endMs - startMs) / DAY_MS) + 1
    if (spanDays > LONG_FREEZE_WARNING_DAYS) {
      warnings.push({
        field: `${prefix}.endDate`,
        message: `Change freeze spans ${spanDays} days (over ${LONG_FREEZE_WARNING_DAYS}) — confirm this long a freeze is intentional`,
        code: 'long_freeze',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
