// =============================================================================
// Shared helpers for the GravityZone Integrations config type.
//
// Integrations are reconciled by NAME (GravityZone assigns the integrationId
// on create). `type` is immutable after creation — updateIntegration has no
// type parameter — so this app never attempts to change it; see deploy.ts.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, listAllPaged, parseJsonObject, readOptionalNumber, str } from '../../lib/gravityZoneCommon'
import { getConfiguredIntegrations, type GzIntegration } from '../../lib/gravityZoneApi'
import type { GravityZoneClient } from '../../lib/gravityZone'

export interface IntegrationSpec {
  itemName: string
  name: string
  type: number
  specificsRaw: string
}

/** The integration's logical identity: its name, trimmed and lower-cased for matching. */
export function integrationKey(name: string): string {
  return name.trim().toLowerCase()
}

export function extractIntegrationSpecs(canvas: CanvasSnapshot): IntegrationSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: str(fields.name),
      type: readOptionalNumber(fields.type) ?? 1,
      specificsRaw: str(fields.specifics),
    }
  })
}

/** Parse the declared Specifics JSON object. */
export function parseSpecifics(spec: IntegrationSpec): { value: Record<string, unknown> | null; error: string | null } {
  return parseJsonObject(spec.specificsRaw, `Integration "${spec.name}" Specifics`)
}

export function findLiveIntegration(live: GzIntegration[], name: string): GzIntegration | undefined {
  const key = integrationKey(name)
  return live.find((i) => integrationKey(i.name ?? '') === key)
}

export function liveIntegrationId(integration: GzIntegration): string {
  const id = integration.id ?? integration.integrationId
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}

/** Fetch every integration across every page (see lib/gravityZoneCommon.ts listAllPaged). */
export async function listAllIntegrations(client: GravityZoneClient): Promise<GzIntegration[]> {
  return listAllPaged((page, perPage) => getConfiguredIntegrations(client, { page, perPage }))
}

/** Does the live (full-detail) integration's name/specifics already match the declared spec? Type is immutable and never compared. */
export function integrationFieldsMatch(spec: IntegrationSpec, specifics: Record<string, unknown> | null, live: GzIntegration): boolean {
  return (live.name ?? '') === spec.name && canonicalJson(live.specifics ?? {}) === canonicalJson(specifics ?? {})
}
