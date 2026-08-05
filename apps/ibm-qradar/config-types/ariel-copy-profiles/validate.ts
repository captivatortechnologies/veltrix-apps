import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar disaster-recovery Ariel Copy Profile constraints -------------
//
// POST /disaster_recovery/ariel_copy_profiles (create), POST .../{id} (update —
// all fields modifiable), DELETE .../{id} (delete). QRadar allows at most ONE
// profile per host (409 "host_id parameter already exists"), so host_id — not
// the canvas item id — is the real identity; "name" here is a canvas-only
// label. Excluded retention buckets are declared by NAME and resolved to ids
// in deploy (event/flow retention buckets are read-only lookups; QRadar itself
// owns their lifecycle — see lib/lookups.ts).

export interface ArielCopyProfileSpec {
  itemId?: string
  /** canvas-only display label; never sent to QRadar. */
  name: string
  /** the Ariel Copy host id — QRadar's real identity for this object (one profile per host). */
  hostId: number
  destinationHostIp: string
  destinationPort?: number
  enabled: boolean
  frequency?: number
  bandwidthLimit?: number
  startDate?: number
  endDate?: number
  excludeEventRetentionBucketNames: string[]
  excludeFlowRetentionBucketNames: string[]
}

/** An Ariel Copy Profile as returned by GET /disaster_recovery/ariel_copy_profiles. */
export interface LiveArielCopyProfile {
  id?: number
  host_id?: number
  destination_host_ip?: string
  destination_port?: number
  enabled?: boolean
  frequency?: number
  bandwidth_limit?: number
  start_date?: number
  end_date?: number
  exclude_event_retention_bucket_ids?: number[]
  exclude_flow_retention_bucket_ids?: number[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

function asStringList(v: unknown): string[] {
  const lines = Array.isArray(v) ? v.map((x) => String(x)) : asString(v).split(/\n/)
  return lines.map((l) => l.trim()).filter(Boolean)
}

export function extractArielCopyProfileSpecs(canvas: CanvasSnapshot): ArielCopyProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      hostId: asInt(f.hostId) ?? 0,
      destinationHostIp: asString(f.destinationHostIp),
      destinationPort: asInt(f.destinationPort),
      enabled: f.enabled === true,
      frequency: asInt(f.frequency),
      bandwidthLimit: asInt(f.bandwidthLimit),
      startDate: asInt(f.startDate),
      endDate: asInt(f.endDate),
      excludeEventRetentionBucketNames: asStringList(f.excludeEventRetentionBucketNames),
      excludeFlowRetentionBucketNames: asStringList(f.excludeFlowRetentionBucketNames),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractArielCopyProfileSpecs(ctx.canvas)
  const seenNames = new Set<string>()
  const seenHostIds = new Set<number>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate profile name "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.hostId || spec.hostId < 1) {
      errors.push({ field: `${prefix}.hostId`, message: 'Host ID is required and must be a positive integer', code: 'required' })
    } else if (seenHostIds.has(spec.hostId)) {
      errors.push({ field: `${prefix}.hostId`, message: `Duplicate host id ${spec.hostId} — QRadar allows only one profile per host`, code: 'duplicate_host' })
    }
    seenHostIds.add(spec.hostId)

    if (!spec.destinationHostIp) {
      errors.push({ field: `${prefix}.destinationHostIp`, message: 'Destination host IP is required', code: 'required' })
    } else if (/\s/.test(spec.destinationHostIp)) {
      errors.push({ field: `${prefix}.destinationHostIp`, message: 'Destination host IP must not contain whitespace', code: 'invalid_ip' })
    }

    if (spec.destinationPort !== undefined && (spec.destinationPort < 1 || spec.destinationPort > 65535)) {
      errors.push({ field: `${prefix}.destinationPort`, message: 'Destination port must be between 1 and 65535', code: 'out_of_range' })
    }
    if (spec.bandwidthLimit !== undefined && spec.bandwidthLimit <= 0) {
      errors.push({ field: `${prefix}.bandwidthLimit`, message: 'Bandwidth limit must be a positive integer', code: 'out_of_range' })
    }
    if (spec.frequency !== undefined && spec.frequency <= 0) {
      errors.push({ field: `${prefix}.frequency`, message: 'Frequency must be a positive integer', code: 'out_of_range' })
    }
    if (spec.startDate !== undefined && spec.endDate !== undefined && spec.endDate < spec.startDate) {
      errors.push({ field: `${prefix}.endDate`, message: 'End date must not be before start date', code: 'invalid_range' })
    }

    if (!spec.enabled) {
      warnings.push({ field: `${prefix}.enabled`, message: 'This profile is not enabled — Ariel Copy will not run for this host', code: 'disabled' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
