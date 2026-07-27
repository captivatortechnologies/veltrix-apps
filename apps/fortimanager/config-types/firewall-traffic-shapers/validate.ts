import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager shared traffic shaper constraints --------------------------

export const MAX_NAME_LENGTH = 35
export const BANDWIDTH_UNITS = ['kbps', 'mbps', 'gbps'] as const
export const PRIORITIES = ['low', 'medium', 'high'] as const

export interface TrafficShaperSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  guaranteedBandwidth?: number
  maximumBandwidth?: number
  bandwidthUnit: string
  priority: string
  /** enable | disable */
  perPolicy: string
  /** enable | disable */
  diffserv: string
  /** 6-bit binary DiffServ code, only meaningful when diffserv=enable. */
  diffservcode: string
}

/** A traffic shaper as returned by a get on the traffic-shaper table. */
export interface LiveTrafficShaper {
  name?: string
  'guaranteed-bandwidth'?: number | string
  'maximum-bandwidth'?: number | string
  'bandwidth-unit'?: string | number
  priority?: string | number
  'per-policy'?: string | number
  diffserv?: string | number
  diffservcode?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function asToggle(v: unknown, dflt: 'enable' | 'disable' = 'disable'): string {
  if (v === true || v === 'enable' || v === 'true') return 'enable'
  if (v === false || v === 'disable' || v === 'false' || v === '') return dflt
  return dflt
}

export function extractTrafficShaperSpecs(canvas: CanvasSnapshot): TrafficShaperSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      guaranteedBandwidth: asNumber(f.guaranteedBandwidth),
      maximumBandwidth: asNumber(f.maximumBandwidth),
      bandwidthUnit: (asString(f.bandwidthUnit) || 'kbps').toLowerCase(),
      priority: (asString(f.priority) || 'high').toLowerCase(),
      perPolicy: asToggle(f.perPolicy),
      diffserv: asToggle(f.diffserv),
      diffservcode: asString(f.diffservcode),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTrafficShaperSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate traffic shaper "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(BANDWIDTH_UNITS as readonly string[]).includes(spec.bandwidthUnit)) {
      errors.push({ field: `${prefix}.bandwidthUnit`, message: `Bandwidth unit must be one of: ${BANDWIDTH_UNITS.join(', ')}`, code: 'invalid_unit' })
    }
    if (!(PRIORITIES as readonly string[]).includes(spec.priority)) {
      errors.push({ field: `${prefix}.priority`, message: `Priority must be one of: ${PRIORITIES.join(', ')}`, code: 'invalid_priority' })
    }

    for (const [field, value] of [
      ['guaranteedBandwidth', spec.guaranteedBandwidth],
      ['maximumBandwidth', spec.maximumBandwidth],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        errors.push({ field: `${prefix}.${field}`, message: 'Bandwidth must be a non-negative integer', code: 'invalid_bandwidth' })
      }
    }
    if (
      spec.guaranteedBandwidth !== undefined &&
      spec.maximumBandwidth !== undefined &&
      spec.guaranteedBandwidth > spec.maximumBandwidth
    ) {
      warnings.push({ field: `${prefix}.guaranteedBandwidth`, message: 'Guaranteed bandwidth exceeds maximum bandwidth', code: 'bandwidth_order' })
    }

    if (spec.diffservcode && !/^[01]{6}$/.test(spec.diffservcode)) {
      errors.push({ field: `${prefix}.diffservcode`, message: 'DiffServ code must be a 6-bit binary value (e.g. 000000)', code: 'invalid_diffservcode' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
