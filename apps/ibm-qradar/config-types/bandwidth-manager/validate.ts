import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar bandwidth manager configuration constraints ------------------
//
// Scope: this type manages bandwidth manager CONFIGURATIONS (store-and-forward
// traffic-shaping caps). Filters (which reference a configuration_id and carry
// port-mask/partner semantics) are intentionally out of scope. Identity is the
// configuration NAME.

export interface BandwidthConfigSpec {
  itemId?: string
  /** name — the configuration's natural identity (matched by name, rename-safe by id). */
  name: string
  hostname: string
  /** managed-host id the cap applies to, or -1 for all hosts. */
  hostId: number
  /** rate cap in KB. */
  kbLimit?: number
  deviceName: string
}

/** A bandwidth configuration as returned by GET /bandwidth_manager/configurations. */
export interface LiveBandwidthConfig {
  id?: number
  name?: string
  hostname?: string
  host_id?: number
  kb_limit?: number
  device_name?: string
  created_by?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

export function extractBandwidthConfigSpecs(canvas: CanvasSnapshot): BandwidthConfigSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      hostname: asString(f.hostname),
      hostId: asInt(f.hostId) ?? -1,
      kbLimit: asInt(f.kbLimit),
      deviceName: asString(f.deviceName),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractBandwidthConfigSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > 100) errors.push({ field: `${prefix}.name`, message: 'Name must be 100 characters or fewer', code: 'too_long' })
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate configuration "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.hostname && spec.hostname.length > 100) {
      errors.push({ field: `${prefix}.hostname`, message: 'Hostname must be 100 characters or fewer', code: 'too_long' })
    }
    if (spec.hostId !== -1 && spec.hostId < 1) {
      errors.push({ field: `${prefix}.hostId`, message: 'Host id must be a positive integer or -1 (all hosts)', code: 'out_of_range' })
    }
    if (spec.kbLimit !== undefined && spec.kbLimit <= 0) {
      errors.push({ field: `${prefix}.kbLimit`, message: 'KB limit must be a positive integer', code: 'out_of_range' })
    }
    if (spec.kbLimit === undefined) {
      warnings.push({ field: `${prefix}.kbLimit`, message: 'This configuration sets no KB limit', code: 'empty_limit' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
