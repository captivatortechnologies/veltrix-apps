// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense
// traffic-shaper-queues config type (`/api/trafficshaper/settings/*Queue`,
// `/api/trafficshaper/service/reconfigure` — see lib/trafficShaperApi.ts's
// module doc). No meaningful OPNsense version floor.
//
// IDENTITY: `description` is REQUIRED on the queue model itself (verified in
// TrafficShaper.xml), so this app uses it as a natural identity, deduped
// case-insensitively per canvas. `number` is server-assigned (never sent).
//
// REFERENCE: `pipe` is a ModelRelationField pointing at a `pipes.pipe` uuid,
// displayed/matched by the pipe's OWN description — this config type
// declares the target pipe by NAME (its description) and resolves it to a
// live uuid at deploy time, the same pattern firewall-rules uses for
// category references.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { LiveQueue, QueueBody } from '../../lib/trafficShaperApi'

export const MASKS = ['none', 'src-ip', 'dst-ip', 'src-ip6', 'dst-ip6'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Trim a string field, defaulting to the canvas item's own `name` ONLY when
 * the raw field value was never provided (undefined/null). An EXPLICIT empty
 * string is preserved as-is, so a required field left genuinely blank is
 * still caught by validate.ts instead of being silently masked by the
 * item's unrelated `name` metadata.
 */
function asStringOrItemName(value: unknown, itemName: string): string {
  if (value === undefined || value === null) return itemName
  return asString(value)
}

export function queueKey(description: string): string {
  return description.trim().toLowerCase()
}

export interface QueueSpec {
  itemId?: string
  description: string
  enabled: boolean
  pipeName: string
  weight: number
  mask: string
  buckets: number | null
  codelEnable: boolean
  codelTarget: number | null
  codelInterval: number | null
  codelEcnEnable: boolean
  pieEnable: boolean
}

export function extractQueueSpecs(canvas: CanvasSnapshot): QueueSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asStringOrItemName(f.description, item.name),
      enabled: asBool(f.enabled, true),
      pipeName: asString(f.pipe_name),
      weight: typeof f.weight === 'number' && Number.isFinite(f.weight) ? f.weight : 100,
      mask: asString(f.mask) || 'none',
      buckets: asNumberOrNull(f.buckets),
      codelEnable: asBool(f.codel_enable, false),
      codelTarget: asNumberOrNull(f.codel_target),
      codelInterval: asNumberOrNull(f.codel_interval),
      codelEcnEnable: asBool(f.codel_ecn_enable, false),
      pieEnable: asBool(f.pie_enable, false),
    }
  })
}

/** Build the addQueue/setQueue body. `pipeUuid` is the already-resolved (name -> uuid) pipe reference. */
export function buildQueueBody(spec: QueueSpec, pipeUuid: string): QueueBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    pipe: pipeUuid,
    weight: String(spec.weight),
    mask: spec.mask,
    buckets: spec.buckets != null ? String(spec.buckets) : '',
    codel_enable: spec.codelEnable ? '1' : '0',
    codel_target: spec.codelTarget != null ? String(spec.codelTarget) : '',
    codel_interval: spec.codelInterval != null ? String(spec.codelInterval) : '',
    codel_ecn_enable: spec.codelEcnEnable ? '1' : '0',
    pie_enable: spec.pieEnable ? '1' : '0',
    description: spec.description,
  }
}

export function snapshotLive(live: LiveQueue): QueueBody {
  return {
    enabled: String(live.enabled ?? '1'),
    pipe: String(live.pipe ?? ''),
    weight: String(live.weight ?? '100'),
    mask: String(live.mask ?? 'none'),
    buckets: String(live.buckets ?? ''),
    codel_enable: String(live.codel_enable ?? '0'),
    codel_target: String(live.codel_target ?? ''),
    codel_interval: String(live.codel_interval ?? ''),
    codel_ecn_enable: String(live.codel_ecn_enable ?? '0'),
    pie_enable: String(live.pie_enable ?? '0'),
    description: String(live.description ?? ''),
  }
}

export function isValidMask(value: string): boolean {
  return (MASKS as readonly string[]).includes(value)
}
