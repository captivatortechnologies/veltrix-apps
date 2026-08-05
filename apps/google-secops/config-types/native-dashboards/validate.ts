import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps native dashboard constraints -------------------------------
// A Chronicle SIEM "Native Dashboard" — a dashboard CONTAINER plus its global
// filters. https://cloud.google.com/chronicle/docs/reference/rest/v1/projects.locations.instances.nativeDashboards
// Field list verified against google_chronicle_native_dashboard in Google's own
// terraform-provider-google (GoogleCloudPlatform/magic-modules
// mmv1/products/chronicle/NativeDashboard.yaml — the authoritative source, since
// the resource is not yet documented with a full field table on the public
// reference site).
//
// SCOPE: this type manages the dashboard shell (displayName, description,
// access, pinned) and its dashboard-level FILTERS only. Chart CONTENT (the
// visualization/query definitions) is out of scope — see the README Coverage
// section: charts have their own create/update/delete lifecycle via custom
// `addChart` / `editChart` / `removeChart` RPCs on the dashboard, backed by an
// extremely deep and still-evolving visualization schema (confirmed via the
// same magic-modules source: per-axis/series/legend/table/button/markdown/
// map/drill-down configuration). Declare charts in the SecOps console after
// creating the dashboard shell here.

export const ACCESS_LEVELS = ['DASHBOARD_PRIVATE', 'DASHBOARD_PUBLIC'] as const

/** DashboardFilter.dataSource enum (NativeDashboard.yaml). */
export const FILTER_DATA_SOURCES = [
  'UDM',
  'ENTITY',
  'INGESTION_METRICS',
  'RULE_DETECTIONS',
  'RULESETS',
  'GLOBAL',
  'IOC_MATCHES',
  'RULES',
  'SOAR_CASES',
  'SOAR_PLAYBOOKS',
  'SOAR_CASE_HISTORY',
  'DATA_TABLE',
  'INVESTIGATION',
  'INVESTIGATION_FEEDBACK',
] as const

/** FilterOperatorAndFieldValues.filterOperator enum (NativeDashboard.yaml). */
export const FILTER_OPERATORS = [
  'EQUAL',
  'NOT_EQUAL',
  'IN',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL_TO',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL_TO',
  'BETWEEN',
  'PAST',
  'IS_NULL',
  'IS_NOT_NULL',
  'STARTS_WITH',
  'ENDS_WITH',
  'DOES_NOT_STARTS_WITH',
  'DOES_NOT_ENDS_WITH',
  'NOT_IN',
  'CONTAINS',
  'DOES_NOT_CONTAIN',
] as const

export interface DashboardFilter {
  id: string
  displayName?: string
  dataSource?: string
  fieldPath?: string
  isMandatory?: boolean
  isStandardTimeRangeFilter?: boolean
  isStandardTimeRangeFilterEnabled?: boolean
  chartIds?: string[]
  filterOperatorAndFieldValues?: Array<{ fieldValues?: string[]; filterOperator?: string }>
}

export interface NativeDashboardSpec {
  itemId?: string
  /** displayName = the dashboard's identity we own (the dashboardId is server-assigned). */
  displayName: string
  description: string
  access: string
  isPinned: boolean
  filtersRaw: string
  /** Parsed filters, or null when the JSON is malformed. */
  filters: DashboardFilter[] | null
}

/** A dashboard as returned by the SecOps API. `name` is `{parent}/nativeDashboards/{dashboardId}`. */
export interface LiveNativeDashboard {
  name?: string
  displayName?: string
  description?: string
  access?: string
  type?: string
  dashboardUserData?: { isPinned?: boolean }
  definition?: { filters?: DashboardFilter[]; charts?: unknown[]; fingerprint?: string }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

/** Parse the filters JSON array, or null when malformed. */
export function parseFilters(raw: string): DashboardFilter[] | null {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const filters: DashboardFilter[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const f = entry as Record<string, unknown>
    if (typeof f.id !== 'string' || !f.id.trim()) return null
    filters.push(f as unknown as DashboardFilter)
  }
  return filters
}

export function extractNativeDashboardSpecs(canvas: CanvasSnapshot): NativeDashboardSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const filtersRaw = asString(f.filters)
    return {
      itemId: item.id,
      displayName: asString(f.displayName) || item.name,
      description: asString(f.description),
      access: (asString(f.access) || 'DASHBOARD_PRIVATE').toUpperCase(),
      isPinned: asBool(f.isPinned),
      filtersRaw,
      filters: parseFilters(filtersRaw),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractNativeDashboardSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else {
      const key = spec.displayName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.displayName`, message: `Duplicate dashboard "${spec.displayName}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(ACCESS_LEVELS as readonly string[]).includes(spec.access)) {
      errors.push({ field: `${prefix}.access`, message: `Access must be one of: ${ACCESS_LEVELS.join(', ')}`, code: 'invalid_access' })
    }

    if (spec.filtersRaw && !spec.filters) {
      errors.push({
        field: `${prefix}.filters`,
        message: 'Filters must be a JSON array of objects, each with a non-empty "id"',
        code: 'invalid_json',
      })
      return
    }

    const seenFilterIds = new Set<string>()
    ;(spec.filters ?? []).forEach((filter, fi) => {
      const fPrefix = `${prefix}.filters[${fi}]`
      const filterId = filter.id.toLowerCase()
      if (seenFilterIds.has(filterId)) {
        errors.push({ field: fPrefix, message: `Duplicate filter id "${filter.id}" within this dashboard`, code: 'duplicate_filter_id' })
      }
      seenFilterIds.add(filterId)

      if (filter.dataSource && !(FILTER_DATA_SOURCES as readonly string[]).includes(filter.dataSource)) {
        errors.push({ field: `${fPrefix}.dataSource`, message: `Filter dataSource must be one of: ${FILTER_DATA_SOURCES.join(', ')}`, code: 'invalid_data_source' })
      }

      ;(filter.filterOperatorAndFieldValues ?? []).forEach((fofv, oi) => {
        if (fofv.filterOperator && !(FILTER_OPERATORS as readonly string[]).includes(fofv.filterOperator)) {
          errors.push({
            field: `${fPrefix}.filterOperatorAndFieldValues[${oi}].filterOperator`,
            message: `Filter operator must be one of: ${FILTER_OPERATORS.join(', ')}`,
            code: 'invalid_filter_operator',
          })
        }
      })
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
