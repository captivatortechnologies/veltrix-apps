// Shared domain logic for every Automox config type that manages a `/policies`
// object (policies = patch; worklets = custom/required_software). Both write
// to the SAME underlying Automox resource, just with a different
// `policy_type_name` and `configuration` shape, so the wire-level plumbing
// (list/get/create-id-resolution, the common envelope fields, schedule
// bitmasks, device filters, rollback capture) lives here once.
//
// VERIFIED against the official OpenAPI description published in the Automox
// Console Python SDK (swagger-codegen, MIT license):
//   https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml
// and cross-checked against the community Automox MCP server's live-tested
// policy workflow (Apache-2.0), which documents several behaviors the OpenAPI
// spec does not:
//   https://github.com/AutomoxCommunity/automox-mcp/blob/main/src/automox_mcp/workflows/policy_crud.py

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { automoxErrorMessage, parseJson, type AutomoxClient } from '../../lib/automoxApi'
import { readBool, strList, intList, str, num } from './canvasValues'

export const POLICY_TYPES = ['patch', 'required_software', 'custom'] as const
export type PolicyTypeName = (typeof POLICY_TYPES)[number]

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

/** Convert canvas day-name selections into the Automox `schedule_days` bitmask. */
export function dayNamesToBitmask(days: string[]): number {
  return days.reduce((mask, day) => mask | (DAY_BITMASK[day.trim().toLowerCase()] ?? 0), 0)
}

/** Device filter clause fields/ops accepted by `configuration.device_filters` (patch, custom AND required_software all support it). */
export const DEVICE_FILTER_FIELDS = ['tag', 'hostname', 'ip_addr', 'os_family', 'os_version_id', 'organizational_unit'] as const
export const DEVICE_FILTER_OPS = ['in', 'not_in', 'like_any', 'not_like_any'] as const

/** A device filter clause, as sent in `configuration.device_filters`. */
export interface AutomoxDeviceFilter {
  field: string
  op: string
  value: Array<string | number | boolean>
}

export interface ParsedDeviceFilters {
  filters: AutomoxDeviceFilter[]
  error?: string
}

/**
 * Parse the raw device-filters JSON into `configuration.device_filters`
 * clauses. An empty string is valid (no device targeting). Returns an `error`
 * instead of throwing so a config type's validate.ts can surface it as a
 * field error.
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

/** A policy as returned by GET /policies and GET /policies/{id} — any policy_type_name. */
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

/** The policy's logical identity: its name (case-insensitive, trimmed). */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Find a live policy by name (case-insensitive). When `expectedType` is
 * given, a live policy is only matched if its `policy_type_name` is the same
 * type (or the list response omitted the field) — this keeps the `policies`
 * (patch) and `worklets` (custom/required_software) config types from
 * colliding when an operator reuses the same name across both, since they
 * both reconcile against the same underlying `/policies` collection.
 */
export function findPolicyByName(policies: AutomoxPolicy[], name: string, expectedType?: PolicyTypeName): AutomoxPolicy | null {
  const target = policyKey(name)
  if (!target) return null
  return (
    policies.find((p) => {
      if (policyKey(String(p.name ?? '')) !== target) return false
      if (expectedType && p.policy_type_name && p.policy_type_name !== expectedType) return false
      return true
    }) ?? null
  )
}

/** The subset of a live policy's fields every config type manages — captured for rollback. */
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

// --- Common (schedule + identity) fields, shared across every policy type ----

export interface PolicyScheduleFields {
  /** `schedule_days` bitmask; 0 means unscheduled. */
  scheduleDays: number
  scheduleDayNames: string[]
  scheduleTime: string
  /** null = auto-fill the Automox "all weeks/months" default when scheduled. */
  scheduleWeeksOfMonth: number | null
  scheduleMonths: number | null
  useScheduledTimezone: boolean
  scheduledTimezone: string
}

export interface PolicyCommonFields extends PolicyScheduleFields {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** Policy name — the logical identity live policies are matched on. */
  name: string
  notes: string
  serverGroups: number[]
  serverGroupsRaw: string[]
}

/**
 * Extract the fields common to every policy type from one canvas item. Field
 * keys (`name`, `notes`, `server_groups`, `schedule_days`, `schedule_time`,
 * `schedule_weeks_of_month`, `schedule_months`, `use_scheduled_timezone`,
 * `scheduled_timezone`) are a shared convention across the `policies` and
 * `worklets` canvases.
 */
export function extractPolicyCommonFields(item: CanvasItemSnapshot): PolicyCommonFields {
  const fields = item.fields ?? {}
  const dayNames = strList(fields.schedule_days)
  return {
    itemId: item.id,
    name: str(fields.name),
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
  }
}

/**
 * Build the full Automox policy body for POST/PUT /policies from the common
 * fields, a policy type, and an already-built `configuration` object. Automox
 * requires `schedule_weeks_of_month` and `schedule_months` to also be set
 * whenever `schedule_days` is non-zero (verified via automox-mcp); when the
 * operator leaves them blank this auto-fills the "every week, every month"
 * bitmasks rather than silently creating a policy that never runs.
 */
export function buildPolicyEnvelope(
  common: PolicyCommonFields,
  policyTypeName: PolicyTypeName,
  organizationId: number,
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  const scheduled = common.scheduleDays > 0
  const body: Record<string, unknown> = {
    name: common.name,
    policy_type_name: policyTypeName,
    organization_id: organizationId,
    configuration,
    schedule_days: common.scheduleDays,
    schedule_time: common.scheduleTime,
    schedule_weeks_of_month: scheduled ? (common.scheduleWeeksOfMonth ?? ALL_WEEKS_OF_MONTH) : (common.scheduleWeeksOfMonth ?? 0),
    schedule_months: scheduled ? (common.scheduleMonths ?? ALL_MONTHS) : (common.scheduleMonths ?? 0),
    server_groups: common.serverGroups,
    notes: common.notes,
    use_scheduled_timezone: common.useScheduledTimezone,
  }
  if (common.useScheduledTimezone && common.scheduledTimezone) {
    body.scheduled_timezone = common.scheduledTimezone
  }
  return body
}

// --- Wire operations (list / get / resolve-created-id) -----------------------

/** List every Policy in the org, following pagination. */
export async function listPolicies(client: AutomoxClient): Promise<AutomoxPolicy[]> {
  const res = await client.listAllPaged<AutomoxPolicy>('/policies')
  if (!res.ok) {
    throw new Error(`Failed to list Policies: ${automoxErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a policy by id, or null on 404 / any non-ok. */
export async function getPolicyById(client: AutomoxClient, id: number): Promise<AutomoxPolicy | null> {
  const res = await client.request('GET', `/policies/${id}`)
  if (!res.ok) return null
  const policy = parseJson<AutomoxPolicy>(res.body)
  return policy?.id ? policy : null
}

const CREATED_POLICY_LOOKUP_MAX_PAGES = 40

/**
 * Resolve a just-created policy's id by name. VERIFIED (automox-mcp
 * workflow, not documented in the OpenAPI spec): `POST /policies` returns 201
 * with an EMPTY body — the new id is not in the response. `/policies` is
 * name-ordered, not recency-ordered, so every matching name (optionally
 * narrowed to `expectedType` to avoid picking up an unrelated policy of a
 * different type) is collected and the HIGHEST id (the newest) is returned.
 */
export async function resolveCreatedPolicyId(client: AutomoxClient, name: string, expectedType?: PolicyTypeName): Promise<number | null> {
  const target = policyKey(name)
  if (!target) return null

  const matches: number[] = []
  for (let page = 0; page < CREATED_POLICY_LOOKUP_MAX_PAGES; page++) {
    const res = await client.request('GET', '/policies', { query: { page, limit: 250 } })
    if (!res.ok) break
    const rows = parseJson<AutomoxPolicy[]>(res.body)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      if (policyKey(String(row.name ?? '')) !== target || typeof row.id !== 'number') continue
      if (expectedType && row.policy_type_name && row.policy_type_name !== expectedType) continue
      matches.push(row.id)
    }
    if (rows.length < 250) break
  }
  return matches.length > 0 ? Math.max(...matches) : null
}

/** A 201 body is documented as empty, but tolerate a future API returning `{ id }` / `{ policy_id }`. */
export function extractCreatedPolicyId(body: string): number | null {
  const parsed = parseJson<{ id?: unknown; policy_id?: unknown }>(body)
  const candidate = parsed?.id ?? parsed?.policy_id
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number.parseInt(candidate, 10)
  return null
}
