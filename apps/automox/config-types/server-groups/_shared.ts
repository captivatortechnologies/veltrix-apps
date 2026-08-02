// Shared helpers for the Automox Server Groups config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Server Groups are applied over the Automox Console API (`/servergroups`),
// org-scoped via the `o` query parameter — a DIFFERENT resource from
// `/policies` (see ../lib/automoxPolicies), so this config type is
// self-contained rather than sharing that library.
//
// VERIFIED against the official OpenAPI description published in the Automox
// Console Python SDK (swagger-codegen, MIT license):
//   https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml
//   (schema: ServerGroupCreateOrUpdateRequest — required: name,
//   refresh_interval (360-1440 minutes), parent_server_group_id; optional:
//   ui_color, notes, enable_os_auto_update (nullable bool: null = keep
//   device's setting), enable_wsus (nullable bool: null = keep device's
//   setting), wsus_server, policies (ids to link). Unlike POST /policies,
//   `POST /servergroups` returns 200 with the FULL created ServerGroup object
//   — no id-resolution workaround is needed here.)
//
// `parent_server_group_id` is REQUIRED by Automox for every group, including
// top-level ones — per the spec, use the organization's "Default Group" id to
// make a group top-level. This app does not attempt to auto-discover that id
// (FLAGGED — DROP rather than guess): the operator supplies it directly
// (found via the Automox Console or `GET /servergroups`).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { strList, intList, str, num } from '../lib/canvasValues'

/** Tri-state: `null` = keep each device's own setting, matching Automox's nullable enforce flags. */
export const TRI_STATE_OPTIONS = ['keep', 'enable', 'disable'] as const
export type TriState = (typeof TRI_STATE_OPTIONS)[number]

/** Map a canvas tri-state select value to the wire's nullable boolean. */
export function triStateToBool(value: TriState): boolean | null {
  if (value === 'enable') return true
  if (value === 'disable') return false
  return null
}

/** Map a live wire nullable boolean back to the canvas tri-state value (for display/drift). */
export function boolToTriState(value: boolean | null | undefined): TriState {
  if (value === true) return 'enable'
  if (value === false) return 'disable'
  return 'keep'
}

/** A Server Group as returned by GET /servergroups and GET /servergroups/{id}. */
export interface AutomoxServerGroup {
  id?: number
  organization_id?: number
  name?: string
  refresh_interval?: number
  parent_server_group_id?: number
  ui_color?: string
  notes?: string
  enable_os_auto_update?: boolean | null
  enable_wsus?: boolean | null
  wsus_server?: string
  server_count?: number
  policies?: number[]
  [key: string]: unknown
}

/** The group's logical identity: its name (case-insensitive, trimmed). */
export function serverGroupKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Find a live Server Group by name (case-insensitive — the stable identity). */
export function findServerGroupByName(groups: AutomoxServerGroup[], name: string): AutomoxServerGroup | null {
  const target = serverGroupKey(name)
  if (!target) return null
  return groups.find((g) => serverGroupKey(String(g.name ?? '')) === target) ?? null
}

/** The desired state for one Server Group, extracted from a canvas item. */
export interface ServerGroupSpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  name: string
  refreshInterval: number
  parentServerGroupId: number | null
  uiColor: string
  notes: string
  enableOsAutoUpdate: TriState
  enableWsus: TriState
  wsusServer: string
  policyIdsRaw: string[]
  policyIds: number[]
}

const DEFAULT_REFRESH_INTERVAL_MINUTES = 1440

/** Each canvas item describes one Automox Server Group. */
export function extractServerGroupSpecs(canvas: CanvasSnapshot): ServerGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: str(fields.name),
      refreshInterval: num(fields.refresh_interval) ?? DEFAULT_REFRESH_INTERVAL_MINUTES,
      parentServerGroupId: num(fields.parent_server_group_id),
      uiColor: str(fields.ui_color),
      notes: str(fields.notes),
      enableOsAutoUpdate: (str(fields.enable_os_auto_update) || 'keep') as TriState,
      enableWsus: (str(fields.enable_wsus) || 'keep') as TriState,
      wsusServer: str(fields.wsus_server),
      policyIdsRaw: strList(fields.policies),
      policyIds: intList(fields.policies),
    }
  })
}

/** Build the Automox `ServerGroupCreateOrUpdateRequest` body for POST/PUT /servergroups. */
export function buildServerGroupBody(spec: ServerGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    refresh_interval: spec.refreshInterval,
    parent_server_group_id: spec.parentServerGroupId,
    notes: spec.notes,
    enable_os_auto_update: triStateToBool(spec.enableOsAutoUpdate),
    enable_wsus: triStateToBool(spec.enableWsus),
    policies: spec.policyIds,
  }
  if (spec.uiColor) body.ui_color = spec.uiColor
  if (spec.wsusServer) body.wsus_server = spec.wsusServer
  return body
}

/** The subset of a live server group's fields this config type manages — captured for rollback. */
export function priorServerGroupFieldsOf(group: AutomoxServerGroup): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(group.name ?? ''),
    refresh_interval: group.refresh_interval ?? DEFAULT_REFRESH_INTERVAL_MINUTES,
    parent_server_group_id: group.parent_server_group_id ?? null,
    notes: group.notes ?? '',
    enable_os_auto_update: group.enable_os_auto_update ?? null,
    enable_wsus: group.enable_wsus ?? null,
    policies: Array.isArray(group.policies) ? group.policies : [],
  }
  if (group.ui_color) body.ui_color = group.ui_color
  if (group.wsus_server) body.wsus_server = group.wsus_server
  return body
}
