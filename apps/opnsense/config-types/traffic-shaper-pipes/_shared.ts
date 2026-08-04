// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense
// traffic-shaper-pipes config type (`/api/trafficshaper/settings/*Pipe`,
// `/api/trafficshaper/service/reconfigure` — see lib/trafficShaperApi.ts's
// module doc). No meaningful OPNsense version floor.
//
// IDENTITY: `description` is REQUIRED on the pipe model itself (verified in
// TrafficShaper.xml), so — unlike firewall-rules/source-nat/one-to-one-nat —
// this app can safely use it as a natural, name-like identity, deduped
// case-insensitively per canvas the same way firewall-aliases/categories are.
// `number` (the pf dnpipe id) is SERVER-ASSIGNED and never sent by this app
// — see lib/trafficShaperApi.ts's module doc.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { LivePipe, PipeBody } from '../../lib/trafficShaperApi'

export const BANDWIDTH_METRICS = ['bit', 'Kbit', 'Mbit', 'Gbit'] as const
export const MASKS = ['none', 'src-ip', 'dst-ip', 'src-ip6', 'dst-ip6'] as const
export const SCHEDULERS = ['', 'fifo', 'rr', 'qfq', 'fq_codel', 'fq_pie'] as const

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

export function pipeKey(description: string): string {
  return description.trim().toLowerCase()
}

export interface PipeSpec {
  itemId?: string
  description: string
  enabled: boolean
  bandwidth: number
  bandwidthMetric: string
  queue: number | null
  mask: string
  buckets: number | null
  scheduler: string
  codelEnable: boolean
  codelTarget: number | null
  codelInterval: number | null
  codelEcnEnable: boolean
  pieEnable: boolean
  fqcodelQuantum: number | null
  fqcodelLimit: number | null
  fqcodelFlows: number | null
  delay: number | null
}

export function extractPipeSpecs(canvas: CanvasSnapshot): PipeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asStringOrItemName(f.description, item.name),
      enabled: asBool(f.enabled, true),
      bandwidth: typeof f.bandwidth === 'number' && Number.isFinite(f.bandwidth) ? f.bandwidth : 0,
      bandwidthMetric: asString(f.bandwidthMetric) || 'Kbit',
      queue: asNumberOrNull(f.queue),
      mask: asString(f.mask) || 'none',
      buckets: asNumberOrNull(f.buckets),
      scheduler: asString(f.scheduler),
      codelEnable: asBool(f.codel_enable, false),
      codelTarget: asNumberOrNull(f.codel_target),
      codelInterval: asNumberOrNull(f.codel_interval),
      codelEcnEnable: asBool(f.codel_ecn_enable, false),
      pieEnable: asBool(f.pie_enable, false),
      fqcodelQuantum: asNumberOrNull(f.fqcodel_quantum),
      fqcodelLimit: asNumberOrNull(f.fqcodel_limit),
      fqcodelFlows: asNumberOrNull(f.fqcodel_flows),
      delay: asNumberOrNull(f.delay),
    }
  })
}

export function buildPipeBody(spec: PipeSpec): PipeBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    bandwidth: String(spec.bandwidth),
    bandwidthMetric: spec.bandwidthMetric,
    queue: spec.queue != null ? String(spec.queue) : '',
    mask: spec.mask,
    buckets: spec.buckets != null ? String(spec.buckets) : '',
    scheduler: spec.scheduler,
    codel_enable: spec.codelEnable ? '1' : '0',
    codel_target: spec.codelTarget != null ? String(spec.codelTarget) : '',
    codel_interval: spec.codelInterval != null ? String(spec.codelInterval) : '',
    codel_ecn_enable: spec.codelEcnEnable ? '1' : '0',
    pie_enable: spec.pieEnable ? '1' : '0',
    fqcodel_quantum: spec.fqcodelQuantum != null ? String(spec.fqcodelQuantum) : '',
    fqcodel_limit: spec.fqcodelLimit != null ? String(spec.fqcodelLimit) : '',
    fqcodel_flows: spec.fqcodelFlows != null ? String(spec.fqcodelFlows) : '',
    delay: spec.delay != null ? String(spec.delay) : '',
    description: spec.description,
  }
}

export function snapshotLive(live: LivePipe): PipeBody {
  return {
    enabled: String(live.enabled ?? '1'),
    bandwidth: String(live.bandwidth ?? '0'),
    bandwidthMetric: String(live.bandwidthMetric ?? 'Kbit'),
    queue: String(live.queue ?? ''),
    mask: String(live.mask ?? 'none'),
    buckets: String(live.buckets ?? ''),
    scheduler: String(live.scheduler ?? ''),
    codel_enable: String(live.codel_enable ?? '0'),
    codel_target: String(live.codel_target ?? ''),
    codel_interval: String(live.codel_interval ?? ''),
    codel_ecn_enable: String(live.codel_ecn_enable ?? '0'),
    pie_enable: String(live.pie_enable ?? '0'),
    fqcodel_quantum: String(live.fqcodel_quantum ?? ''),
    fqcodel_limit: String(live.fqcodel_limit ?? ''),
    fqcodel_flows: String(live.fqcodel_flows ?? ''),
    delay: String(live.delay ?? ''),
    description: String(live.description ?? ''),
  }
}

export function isValidBandwidthMetric(value: string): boolean {
  return (BANDWIDTH_METRICS as readonly string[]).includes(value)
}
export function isValidMask(value: string): boolean {
  return (MASKS as readonly string[]).includes(value)
}
export function isValidScheduler(value: string): boolean {
  return (SCHEDULERS as readonly string[]).includes(value)
}
