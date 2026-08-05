import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// External Dynamic Lists (/Objects/ExternalDynamicLists) — threat-feed / GeoIP /
// custom block-list sources fetched on a recurring schedule, referenced by name
// from address objects, address groups and security rules. Cited: PAN-OS REST
// API "Objects" category, class ExternalDynamicLists in pypanrestv2
// (github.com/mrzepa/pypanrestv2, Objects.py), and terraform-provider-panos
// panos_external_dynamic_list (type.{ip,domain,url}.{url,description,
// exception_list,certificate_profile,recurring}).
//
// Modeled types: ip, domain, url (the three custom-source list types). imei /
// imsi (mobile-carrier identifiers) and predefined_ip / predefined_url (tuning
// a Palo-Alto-hosted built-in list rather than authoring a source) are niche
// and not represented. Authenticated source URLs (type.*.auth.username/
// password) are NOT modeled: PAN-OS masks the password on every GET, so it
// cannot be diffed or round-tripped — declare an unauthenticated source URL, or
// manage that one field by hand.
export const RESOURCE_PATH = '/Objects/ExternalDynamicLists'

export const EDL_TYPES = ['ip', 'domain', 'url'] as const
export type EdlType = (typeof EDL_TYPES)[number]

export const RECURRING_INTERVALS = ['five_minute', 'hourly', 'daily', 'weekly', 'monthly'] as const
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number]

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

const HOUR_RE = /^([01]?\d|2[0-3])$/

export interface ExternalDynamicListSpec {
  sectionName: string
  name: string
  type: string
  sourceUrl: string
  description: string
  exceptionList: string[]
  certificateProfile: string
  recurring: string
  recurringAt: string
  recurringDayOfWeek: string
  recurringDayOfMonth: number | null
  expandDomain: boolean
}

interface LiveEdlTypeEntry {
  url?: string
  description?: string
  'exception-list'?: { member?: string[] }
  'certificate-profile'?: string
  'expand-domain'?: string
  recurring?: {
    'five-minute'?: Record<string, never>
    hourly?: Record<string, never>
    daily?: { at?: string }
    weekly?: { at?: string; 'day-of-week'?: string }
    monthly?: { at?: string; 'day-of-month'?: string | number }
  }
}

export interface LiveExternalDynamicList extends PanoramaEntry {
  type?: Partial<Record<EdlType, LiveEdlTypeEntry>>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractExternalDynamicListSpecs(canvas: CanvasSnapshot): ExternalDynamicListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawDom = fields.recurring_day_of_month
    const dayOfMonth = typeof rawDom === 'number' ? rawDom : typeof rawDom === 'string' && rawDom.trim() ? Number(rawDom) : null
    return {
      sectionName: section.name,
      name: str(fields.name),
      type: str(fields.type) || 'url',
      sourceUrl: str(fields.source_url),
      description: str(fields.description),
      exceptionList: splitList(fields.exception_list),
      certificateProfile: str(fields.certificate_profile),
      recurring: str(fields.recurring) || 'hourly',
      recurringAt: str(fields.recurring_at),
      recurringDayOfWeek: str(fields.recurring_day_of_week) || 'sunday',
      recurringDayOfMonth: Number.isFinite(dayOfMonth) ? (dayOfMonth as number) : null,
      expandDomain: coerceBoolean(fields.expand_domain, false),
    }
  })
}

/** Build the REST `recurring` element for the chosen interval. */
export function buildRecurring(spec: ExternalDynamicListSpec): Record<string, unknown> {
  switch (spec.recurring) {
    case 'five_minute':
      return { 'five-minute': {} }
    case 'hourly':
      return { hourly: {} }
    case 'daily':
      return spec.recurringAt ? { daily: { at: spec.recurringAt } } : { daily: {} }
    case 'weekly': {
      const weekly: Record<string, unknown> = { 'day-of-week': spec.recurringDayOfWeek }
      if (spec.recurringAt) weekly.at = spec.recurringAt
      return { weekly }
    }
    case 'monthly': {
      const monthly: Record<string, unknown> = {}
      if (spec.recurringDayOfMonth !== null) monthly['day-of-month'] = spec.recurringDayOfMonth
      if (spec.recurringAt) monthly.at = spec.recurringAt
      return { monthly }
    }
    default:
      return { hourly: {} }
  }
}

/** Build the REST fields for one EDL — a single `type.<kind>` entry. */
export function buildExternalDynamicListFields(spec: ExternalDynamicListSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { url: spec.sourceUrl, recurring: buildRecurring(spec) }
  if (spec.description) entry.description = spec.description
  if (spec.exceptionList.length > 0) entry['exception-list'] = { member: spec.exceptionList }
  if (spec.certificateProfile) entry['certificate-profile'] = spec.certificateProfile
  if (spec.type === 'domain') entry['expand-domain'] = spec.expandDomain ? 'yes' : 'no'
  return { type: { [spec.type]: entry } }
}

export function externalDynamicListUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractExternalDynamicListSpecs(canvas)
    .filter((s) => s.name && s.sourceUrl && EDL_TYPES.includes(s.type as EdlType) && RECURRING_INTERVALS.includes(s.recurring as RecurringInterval))
    .map((s) => ({ name: s.name, fields: buildExternalDynamicListFields(s) }))
}

function recurringSummary(recurring: LiveEdlTypeEntry['recurring']): string {
  if (!recurring) return 'none'
  if (recurring['five-minute'] !== undefined) return 'five_minute'
  if (recurring.hourly !== undefined) return 'hourly'
  if (recurring.daily !== undefined) return `daily@${str(recurring.daily.at) || '-'}`
  if (recurring.weekly !== undefined) return `weekly:${str(recurring.weekly['day-of-week']) || '-'}@${str(recurring.weekly.at) || '-'}`
  if (recurring.monthly !== undefined) return `monthly:${String(recurring.monthly['day-of-month'] ?? '-')}@${str(recurring.monthly.at) || '-'}`
  return 'none'
}

export function externalDynamicListDriftDiffs(spec: ExternalDynamicListSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveExternalDynamicList
  const liveType = live.type ? (Object.keys(live.type)[0] as EdlType | undefined) : undefined
  if (liveType !== spec.type) {
    diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveType ?? 'not set', severity: 'critical' })
    return diffs
  }
  const liveEntry = live.type?.[spec.type as EdlType]
  if (str(liveEntry?.url) !== spec.sourceUrl) {
    diffs.push({ field: `${spec.name}.url`, expected: spec.sourceUrl, actual: str(liveEntry?.url) || 'not set', severity: 'critical' })
  }
  const liveExceptions = Array.isArray(liveEntry?.['exception-list']?.member) ? (liveEntry!['exception-list']!.member as string[]) : []
  if (!sameSet(liveExceptions, spec.exceptionList)) {
    diffs.push({ field: `${spec.name}.exception-list`, expected: spec.exceptionList.join(', ') || 'none', actual: liveExceptions.join(', ') || 'none', severity: 'info' })
  }
  if (spec.certificateProfile && str(liveEntry?.['certificate-profile']) !== spec.certificateProfile) {
    diffs.push({ field: `${spec.name}.certificate-profile`, expected: spec.certificateProfile, actual: str(liveEntry?.['certificate-profile']) || 'not set', severity: 'info' })
  }
  const expectedRecurring = recurringSummary(buildRecurring(spec) as LiveEdlTypeEntry['recurring'])
  const actualRecurring = recurringSummary(liveEntry?.recurring)
  if (expectedRecurring !== actualRecurring) {
    diffs.push({ field: `${spec.name}.recurring`, expected: expectedRecurring, actual: actualRecurring, severity: 'warning' })
  }
  if (spec.description && str(liveEntry?.description) !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: str(liveEntry?.description) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate external dynamic lists: a name and source URL are required and the
 * name is unique across the canvas; the type and recurring interval are
 * supported values; and a weekly/monthly recurrence needs its day, with any
 * "at" hour in 0-23.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractExternalDynamicListSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'External dynamic list name is required', code: 'required' })
    }
    if (!spec.sourceUrl) {
      errors.push({ field: `${prefix}.source_url`, message: 'Source URL is required', code: 'required' })
    }
    if (!EDL_TYPES.includes(spec.type as EdlType)) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported type "${spec.type}" — use ip, domain or url`, code: 'invalid_type' })
    }
    if (!RECURRING_INTERVALS.includes(spec.recurring as RecurringInterval)) {
      errors.push({ field: `${prefix}.recurring`, message: `Unsupported recurring interval "${spec.recurring}"`, code: 'invalid_recurring' })
    }
    if (spec.recurringAt && !HOUR_RE.test(spec.recurringAt)) {
      errors.push({ field: `${prefix}.recurring_at`, message: `Invalid hour "${spec.recurringAt}" — use 0-23`, code: 'invalid_hour' })
    }
    if (spec.recurring === 'monthly') {
      if (spec.recurringDayOfMonth === null || spec.recurringDayOfMonth < 1 || spec.recurringDayOfMonth > 31) {
        errors.push({ field: `${prefix}.recurring_day_of_month`, message: 'Monthly recurrence needs a day of month (1-31)', code: 'required' })
      }
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate external dynamic list "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
