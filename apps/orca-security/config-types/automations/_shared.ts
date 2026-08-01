// Shared helpers for the Orca Automations config type (deploy + rollback + drift).
//
// Orca automations follow the /api/automations surface — the same resource
// Orca's Terraform provider `orcasecurity_automation` writes:
//   POST   /api/automations            create; returns { data: { id, ... } }
//   GET    /api/automations/{id}        read;   returns { data: { ... } }
//   GET    /api/automations?limit=&start_at_index=   list { total_items, data:[] }
//   PUT    /api/automations/{id}        update
//   DELETE /api/automations/{id}        delete
// (VERIFIED against terraform-provider-orcasecurity api_client/automation_v2.go.)
//
// Unlike most Orca config surfaces, automations DO publish a list endpoint, so
// identity resolution can fall back to a live name lookup when this canvas has
// no prior rollbackData (a first deploy against automations created out of band).
// The server `id` is still the primary identity and is tracked in rollbackData.
//
// An automation matches alerts with a Sonar query and runs one or more actions.
// The Sonar query and the action list are complex, tool-defined JSON — the
// official provider itself takes the Sonar query as a raw JSON string — so this
// config type takes them as JSON, matching the API 1:1 rather than modelling
// every action type. FLAG: action `type` codes are Orca-internal integers.

import type { OrcaClient } from '../../lib/orcaApi'
import {
  dataFromEnvelope,
  normalizeStringList,
  type ReconcileData,
  type ReconcileEntry,
} from '../../lib/reconcile'

/** Valid Orca automation statuses (mirror canvas.yaml). */
export const STATUSES = new Set<string>(['enabled', 'disabled'])

/** One Orca automation (the managed subset of the /api/automations payload). */
export interface OrcaAutomation {
  id?: string
  name?: string
  description?: string
  status?: string
  business_units?: string[]
  filter?: { sonar_query?: unknown }
  actions?: unknown[]
  [key: string]: unknown
}

export type AutomationRollbackEntry = ReconcileEntry<OrcaAutomation>
export type AutomationRollbackData = ReconcileData<OrcaAutomation>

/** Coerce a canvas value to a valid automation status, defaulting to enabled. */
export function normalizeStatus(value: unknown): string {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'disabled' ? 'disabled' : 'enabled'
}

/**
 * Build the Orca automation body from canvas fields plus the pre-parsed Sonar
 * query and action list (parsing happens in validate/deploy so JSON errors are
 * reported cleanly). The Sonar query is nested under `filter.sonar_query`,
 * matching the API.
 */
export function buildAutomationBody(
  fields: Record<string, unknown>,
  sonarQuery: unknown,
  actions: unknown[],
): OrcaAutomation {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    status: normalizeStatus(fields.status),
    business_units: normalizeStringList(fields.businessUnits),
    filter: { sonar_query: sonarQuery },
    actions,
  }
}

/**
 * Best-effort live lookup of an automation id by name via the list endpoint,
 * paging by items received. Returns null on any error or no match so callers
 * fall back to treating the item as a create.
 */
export async function findAutomationIdByName(client: OrcaClient, name: string): Promise<string | null> {
  const target = name.trim()
  if (!target) return null

  const pageLimit = 300
  let received = 0
  // Cap total pages defensively so a misbehaving endpoint cannot loop forever.
  for (let page = 0; page < 100; page++) {
    const res = await client.request<{ total_items?: number; data?: OrcaAutomation[] }>(
      'GET',
      `/api/automations?limit=${pageLimit}&start_at_index=${received}`,
    )
    if (res.error || !res.data) return null
    const data = Array.isArray(res.data.data) ? res.data.data : []
    const hit = data.find((a) => (a.name ?? '').trim() === target)
    if (hit?.id) return hit.id

    received += data.length
    const total = typeof res.data.total_items === 'number' ? res.data.total_items : received
    if (data.length === 0 || received >= total) return null
  }
  return null
}

/** GET one automation by id, returning its body or null when gone / unreadable. */
export async function readAutomation(client: OrcaClient, id: string): Promise<OrcaAutomation | null> {
  const res = await client.request<unknown>('GET', `/api/automations/${encodeURIComponent(id)}`)
  if (res.error) return null
  return dataFromEnvelope<OrcaAutomation>(res.data)
}
