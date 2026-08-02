// Shared helpers for the Automox Policies config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Policies are applied over the Automox Console API (`/policies`), org-scoped
// via the `o` query parameter. A policy is one of three types
// (`policy_type_name`): `patch`, `required_software` or `custom` (Worklet).
//
// VERIFIED against the official OpenAPI description published in the Automox
// Console Python SDK (swagger-codegen, MIT license):
//   https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml
// and cross-checked against the community Automox MCP server's live-tested
// policy workflow (Apache-2.0), which documents several behaviors the OpenAPI
// spec does not:
//   https://github.com/AutomoxCommunity/automox-mcp/blob/main/src/automox_mcp/workflows/policy_crud.py
//
// This config type models the PATCH policy shape in full (the common case per
// the task brief). `required_software` and `custom` (Worklet) policies are
// accepted with a raw JSON `configuration` object — FLAGGED, see README.md /
// CHANGELOG.md — because their configuration schemas are materially different
// (installer scripts / Worklet code) and out of scope for v0.1.0.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const POLICY_TYPES = ['patch', 'required_software', 'custom'] as const
export type PolicyTypeName = (typeof POLICY_TYPES)[number]

export const PATCH_RULES = ['all', 'filter', 'manual', 'advanced'] as const
export const FILTER_TYPES = ['include', 'exclude', 'severity'] as const

/**
 * Severities accepted by `configuration.severity_filter` on a Patch-by-Severity
 * policy (`patch_rule: filter`, `filter_type: severity`). The published OpenAPI
 * excerpt's enum omits `no_known_cves`; the automox-mcp source (comment citing
 * "Automox Console API.json" lines 107160-107168, verified against a live
 * create-probe) documents the fuller set used here.
 */
export const SEVERITY_FILTERS = ['no_known_cves', 'none', 'unknown', 'low', 'medium', 'high', 'critical'] as const

/** Device filter clause fields/ops accepted by `configuration.device_filters`. */
export const DEVICE_FILTER_FIELDS = ['tag', 'hostname', 'ip_addr', 'os_family', 'os_version_id', 'organizational_unit'] as const
export const DEVICE_FILTER_OPS = ['in', 'not_in', 'like_any', 'not_like_any'] as const

/** Automox's day-of-week -> `schedule_days` bitmask (bit 0 is unused/trailing zero). */
export const DAY_BITMASK: Record<string, number> = {
  sunday: 128,
  monday: 2,
  tuesday: 4,
  wednesday: 8,
  thursday: 16,
  friday: 32,
  saturday: 64,
}
export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** Automox requires schedule_weeks_of_month/schedule_months set whenever schedule_days is; "all" bitmasks. */
export const ALL_WEEKS_OF_MONTH = 62 // weeks 1-5 (111110)
export const ALL_MONTHS = 8190 // Jan-Dec (1111111111110)

/** A device filter clause, as sent in `configuration.device_filters`. */
export interface AutomoxDeviceFilter {
  field: string
  op: string
  value: Array<string | number | boolean>
}

/** A policy as returned by GET /policies and GET /policies/{id}. */
export interface AutomoxPolicy {
  id?: number
  uuid?: string
  name?: string
  policy_type_name?: string
  organization_id?: number
  configuration?: Record<string, unknown>
  schedule_days?: number
  schedule_weeks_of_month?: number
  schedule_months?: number
  schedule_time?: string
  use_scheduled_timezone?: boolean
  scheduled_timezone?: string
  server_groups?: number[]
  notes?: string
  status?: string
  [key: string]: unknown
}

/** The desired state for one Policy, extracted from a canvas item. */
export interface PolicySpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** Policy name — the logical identity live policies are matched on. */
  name: string
  policyTypeName: PolicyTypeName
  notes: string
  serverGroups: number[]
  serverGroupsRaw: string[]
  /** `schedule_days` bitmask; 0 means unscheduled. */
  scheduleDays: number
  scheduleDayNames: string[]
  scheduleTime: string
  /** null = auto-fill the Automox "all weeks/months" default when scheduled. */
  scheduleWeeksOfMonth: number | null
  scheduleMonths: number | null
  useScheduledTimezone: boolean
  scheduledTimezone: string
  // Patch-only fields (policyTypeName === 'patch').
  patchRule: string
  filterType: string
  filters: string[]
  severityFilter: string[]
  autoPatch: boolean
  autoReboot: boolean
  notifyUser: boolean
  notifyRebootUser: boolean
  includeOptional: boolean
  missedPatchWindow: boolean
  deviceFiltersRaw: string
  // required_software / custom — raw passthrough (FLAGGED, see module doc).
  configurationRaw: string
}

/** The policy's logical identity: its name (case-insensitive, trimmed). */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Find a live policy by name (case-insensitive — the stable identity). */
export function findPolicyByName(policies: AutomoxPolicy[], name: string): AutomoxPolicy | null {
  const target = policyKey(name)
  if (!target) return null
  return policies.find((p) => policyKey(String(p.name ?? '')) === target) ?? null
}

/** Coerce a checkbox-ish value to a boolean, falling back when absent/unrecognized. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return []
}

/**
 * Parse a `tags` list of server-group / device ids into integers; drops
 * anything that is not a clean non-negative integer string (e.g. "2.5" or
 * "-1" is dropped rather than silently truncated/coerced by `parseInt`).
 */
export function intList(value: unknown): number[] {
  return strList(value)
    .filter((v) => /^\d+$/.test(v))
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => Number.isSafeInteger(n))
}

/** Convert canvas day-name selections into the Automox `schedule_days` bitmask. */
export function dayNamesToBitmask(days: string[]): number {
  return days.reduce((mask, day) => mask | (DAY_BITMASK[day.trim().toLowerCase()] ?? 0), 0)
}

/** Each canvas item describes one Automox Policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const num = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
      return null
    }
    const dayNames = strList(fields.schedule_days)

    return {
      itemId: item.id,
      name: str(fields.name),
      policyTypeName: (str(fields.policy_type_name) || 'patch') as PolicyTypeName,
      notes: str(fields.notes),
      serverGroupsRaw: strList(fields.server_groups),
      serverGroups: intList(fields.server_groups),
      scheduleDayNames: dayNames,
      scheduleDays: dayNamesToBitmask(dayNames),
      scheduleTime: str(fields.schedule_time) || '00:00',
      scheduleWeeksOfMonth: num(fields.schedule_weeks_of_month),
      scheduleMonths: num(fields.schedule_months),
      useScheduledTimezone: readBool(fields.use_scheduled_timezone, false),
      scheduledTimezone: str(fields.scheduled_timezone),
      patchRule: str(fields.patch_rule) || 'all',
      filterType: str(fields.filter_type) || 'include',
      filters: strList(fields.filters),
      severityFilter: strList(fields.severity_filter),
      autoPatch: readBool(fields.auto_patch, true),
      autoReboot: readBool(fields.auto_reboot, true),
      notifyUser: readBool(fields.notify_user, true),
      notifyRebootUser: readBool(fields.notify_reboot_user, true),
      includeOptional: readBool(fields.include_optional, false),
      missedPatchWindow: readBool(fields.missed_patch_window, false),
      deviceFiltersRaw: typeof fields.device_filters_json === 'string' ? fields.device_filters_json.trim() : '',
      configurationRaw: typeof fields.configuration_json === 'string' ? fields.configuration_json.trim() : '',
    }
  })
}

export interface ParsedDeviceFilters {
  filters: AutomoxDeviceFilter[]
  error?: string
}

/**
 * Parse the raw device-filters JSON into `configuration.device_filters`
 * clauses. An empty string is valid (no device targeting). Returns an `error`
 * instead of throwing so validate.ts can surface it as a field error.
 */
export function parseDeviceFilters(raw: string): ParsedDeviceFilters {
  const text = raw.trim()
  if (!text) return { filters: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { filters: [], error: `Device filters is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) {
    return { filters: [], error: 'Device filters must be a JSON array of { field, op, value } clauses.' }
  }
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { filters: [], error: `device_filters[${i}] must be an object with field/op/value.` }
    }
    const clause = row as Record<string, unknown>
    if (!DEVICE_FILTER_FIELDS.includes(clause.field as (typeof DEVICE_FILTER_FIELDS)[number])) {
      return {
        filters: [],
        error: `device_filters[${i}].field "${String(clause.field)}" must be one of ${DEVICE_FILTER_FIELDS.join(', ')}.`,
      }
    }
    if (!DEVICE_FILTER_OPS.includes(clause.op as (typeof DEVICE_FILTER_OPS)[number])) {
      return {
        filters: [],
        error: `device_filters[${i}].op "${String(clause.op)}" must be one of ${DEVICE_FILTER_OPS.join(', ')}.`,
      }
    }
    if (!Array.isArray(clause.value) || clause.value.length === 0) {
      return { filters: [], error: `device_filters[${i}].value must be a non-empty array.` }
    }
  }
  return { filters: parsed as AutomoxDeviceFilter[] }
}

export interface ParsedConfiguration {
  value: Record<string, unknown>
  error?: string
}

/**
 * Parse the raw `configuration` JSON for a `required_software` / `custom`
 * policy. Lightly validated (must be a JSON object) — the full shape is
 * FLAGGED as out of scope for v0.1.0 (see module doc).
 */
export function parseConfigurationJson(raw: string): ParsedConfiguration {
  const text = raw.trim()
  if (!text) return { value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: {}, error: `Configuration is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, error: 'Configuration must be a JSON object.' }
  }
  return { value: parsed as Record<string, unknown> }
}

export interface BuiltConfiguration {
  configuration: Record<string, unknown>
  error?: string
}

/**
 * Build `configuration` for a `patch` policy. Two live-API behaviors verified
 * via the automox-mcp workflow (not documented in the OpenAPI spec) are
 * applied unconditionally so a create/update never 400s on them:
 *   - `filter_type` is REQUIRED on every patch policy regardless of
 *     `patch_rule` (Automox issue #206) — forced to "all" for non-filter rules.
 *   - `device_filters_enabled` must be explicitly `true` for a supplied
 *     `device_filters` list to take effect — the API silently ignores it
 *     otherwise.
 */
export function buildPatchConfiguration(spec: PolicySpec): BuiltConfiguration {
  const configuration: Record<string, unknown> = {
    auto_patch: spec.autoPatch,
    auto_reboot: spec.autoReboot,
    notify_user: spec.notifyUser,
    notify_reboot_user: spec.notifyRebootUser,
    include_optional: spec.includeOptional,
    missed_patch_window: spec.missedPatchWindow,
    patch_rule: spec.patchRule,
  }

  if (spec.patchRule === 'filter') {
    if (spec.filterType === 'severity') {
      if (spec.severityFilter.length === 0) {
        return { configuration, error: 'Patch Rule "filter" with Filter Type "severity" requires at least one severity.' }
      }
      configuration.filter_type = 'severity'
      configuration.severity_filter = spec.severityFilter
    } else {
      if (spec.filters.length === 0) {
        return {
          configuration,
          error: 'Patch Rule "filter" with Filter Type "include"/"exclude" requires at least one filter pattern.',
        }
      }
      configuration.filter_type = spec.filterType || 'include'
      configuration.filters = spec.filters
    }
  } else {
    // Non-filter rules (all/manual/advanced): filter_type is still required by
    // the live API (issue #206) but meaningless without `filters` — force "all".
    configuration.filter_type = 'all'
  }

  const deviceFilters = parseDeviceFilters(spec.deviceFiltersRaw)
  if (deviceFilters.error) return { configuration, error: deviceFilters.error }
  configuration.device_filters = deviceFilters.filters
  configuration.device_filters_enabled = deviceFilters.filters.length > 0

  return { configuration }
}

/** Build `configuration` for the policy's type — patch is fully modeled, the rest passthrough. */
export function buildConfiguration(spec: PolicySpec): BuiltConfiguration {
  if (spec.policyTypeName === 'patch') return buildPatchConfiguration(spec)
  const parsed = parseConfigurationJson(spec.configurationRaw)
  if (parsed.error) return { configuration: parsed.value, error: parsed.error }
  return { configuration: parsed.value }
}

export interface BuiltPolicyBody {
  body: Record<string, unknown>
  error?: string
}

/**
 * Build the Automox policy body for POST/PUT /policies. Automox requires
 * `schedule_weeks_of_month` and `schedule_months` to also be set whenever
 * `schedule_days` is non-zero (verified via automox-mcp); when the operator
 * leaves them blank this auto-fills the "every week, every month" bitmasks
 * rather than silently creating a policy that never runs.
 */
export function buildPolicyBody(spec: PolicySpec, organizationId: number): BuiltPolicyBody {
  const built = buildConfiguration(spec)
  if (built.error) return { body: {}, error: built.error }

  const scheduled = spec.scheduleDays > 0
  const body: Record<string, unknown> = {
    name: spec.name,
    policy_type_name: spec.policyTypeName,
    organization_id: organizationId,
    configuration: built.configuration,
    schedule_days: spec.scheduleDays,
    schedule_time: spec.scheduleTime,
    schedule_weeks_of_month: scheduled ? (spec.scheduleWeeksOfMonth ?? ALL_WEEKS_OF_MONTH) : (spec.scheduleWeeksOfMonth ?? 0),
    schedule_months: scheduled ? (spec.scheduleMonths ?? ALL_MONTHS) : (spec.scheduleMonths ?? 0),
    server_groups: spec.serverGroups,
    notes: spec.notes,
    use_scheduled_timezone: spec.useScheduledTimezone,
  }
  if (spec.useScheduledTimezone && spec.scheduledTimezone) {
    body.scheduled_timezone = spec.scheduledTimezone
  }
  return { body }
}

/** The subset of a live policy's fields this config type manages — captured for rollback. */
export function priorFieldsOf(policy: AutomoxPolicy): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(policy.name ?? ''),
    policy_type_name: String(policy.policy_type_name ?? 'patch'),
    organization_id: policy.organization_id,
    configuration: policy.configuration ?? {},
    schedule_days: policy.schedule_days ?? 0,
    schedule_time: policy.schedule_time ?? '00:00',
    schedule_weeks_of_month: policy.schedule_weeks_of_month ?? 0,
    schedule_months: policy.schedule_months ?? 0,
    server_groups: Array.isArray(policy.server_groups) ? policy.server_groups : [],
    notes: policy.notes ?? '',
    use_scheduled_timezone: policy.use_scheduled_timezone ?? false,
  }
  if (policy.use_scheduled_timezone && policy.scheduled_timezone) {
    body.scheduled_timezone = policy.scheduled_timezone
  }
  return body
}
