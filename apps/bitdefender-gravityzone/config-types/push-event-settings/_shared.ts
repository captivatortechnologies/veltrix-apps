// =============================================================================
// Shared helpers for the GravityZone Push Event Settings config type.
//
// A tenant-wide singleton: push.setPushEventSettings REPLACES the entire
// configuration (every parameter is required), so there is no partial-field
// skipping here — deploy always sends the full declared object when
// anything differs from the live configuration.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, parseJsonObject, readOptionalNumber, sameSet, splitList, str } from '../../lib/gravityZoneCommon'
import type { GzPushEventSettings, GzSetPushEventSettingsBody } from '../../lib/gravityZoneApi'

export interface PushEventSettingsSpec {
  itemName: string
  status: number
  serviceType: string
  serviceSettingsRaw: string
  subscribeToEventTypes: string[]
}

/** The declared singleton, or null when no item is present. */
export function extractPushEventSettingsSpec(canvas: CanvasSnapshot): PushEventSettingsSpec | null {
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return null
  const fields = item.fields ?? {}
  return {
    itemName: item.name,
    status: readOptionalNumber(fields.status) ?? 1,
    serviceType: str(fields.serviceType),
    serviceSettingsRaw: str(fields.serviceSettings),
    subscribeToEventTypes: splitList(fields.subscribeToEventTypes),
  }
}

export function parseServiceSettings(spec: PushEventSettingsSpec): { value: Record<string, unknown> | null; error: string | null } {
  return parseJsonObject(spec.serviceSettingsRaw, 'Push Event Settings Service Settings')
}

/** Build the full replacement body GravityZone requires — every field is required by setPushEventSettings. */
export function buildPushEventSettingsBody(spec: PushEventSettingsSpec, serviceSettings: Record<string, unknown> | null): GzSetPushEventSettingsBody {
  return {
    status: spec.status,
    serviceType: spec.serviceType,
    serviceSettings: serviceSettings ?? {},
    subscribeToEventTypes: spec.subscribeToEventTypes,
  }
}

/** Does the live configuration already match the declared spec? */
export function pushEventSettingsMatch(spec: PushEventSettingsSpec, serviceSettings: Record<string, unknown> | null, live: GzPushEventSettings): boolean {
  return (
    live.status === spec.status &&
    (live.serviceType ?? '') === spec.serviceType &&
    canonicalJson(live.serviceSettings ?? {}) === canonicalJson(serviceSettings ?? {}) &&
    sameSet(spec.subscribeToEventTypes, Array.isArray(live.subscribeToEventTypes) ? live.subscribeToEventTypes.map(String) : [])
  )
}

/** The prior live configuration, shaped back into the required replacement body — for rollback. */
export function priorAsBody(live: GzPushEventSettings): GzSetPushEventSettingsBody {
  return {
    status: live.status ?? 0,
    serviceType: live.serviceType ?? 'jsonRPC',
    serviceSettings: live.serviceSettings ?? {},
    subscribeToEventTypes: Array.isArray(live.subscribeToEventTypes) ? live.subscribeToEventTypes.map(String) : [],
  }
}
