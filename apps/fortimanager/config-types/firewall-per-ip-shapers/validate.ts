import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager per-IP traffic shaper constraints --------------------------

export const MAX_NAME_LENGTH = 35
export const BANDWIDTH_UNITS = ['kbps', 'mbps', 'gbps'] as const

export interface PerIpShaperSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  maxBandwidth?: number
  bandwidthUnit: string
  maxConcurrentSession?: number
  maxConcurrentTcpSession?: number
  maxConcurrentUdpSession?: number
  /** enable | disable */
  diffservForward: string
  /** enable | disable */
  diffservReverse: string
}

/** A per-IP shaper as returned by a get on the per-ip-shaper table. */
export interface LivePerIpShaper {
  name?: string
  'max-bandwidth'?: number | string
  'bandwidth-unit'?: string | number
  'max-concurrent-session'?: number | string
  'max-concurrent-tcp-session'?: number | string
  'max-concurrent-udp-session'?: number | string
  'diffserv-forward'?: string | number
  'diffserv-reverse'?: string | number
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
  return dflt
}

export function extractPerIpShaperSpecs(canvas: CanvasSnapshot): PerIpShaperSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      maxBandwidth: asNumber(f.maxBandwidth),
      bandwidthUnit: (asString(f.bandwidthUnit) || 'kbps').toLowerCase(),
      maxConcurrentSession: asNumber(f.maxConcurrentSession),
      maxConcurrentTcpSession: asNumber(f.maxConcurrentTcpSession),
      maxConcurrentUdpSession: asNumber(f.maxConcurrentUdpSession),
      diffservForward: asToggle(f.diffservForward),
      diffservReverse: asToggle(f.diffservReverse),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPerIpShaperSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate per-IP shaper "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(BANDWIDTH_UNITS as readonly string[]).includes(spec.bandwidthUnit)) {
      errors.push({ field: `${prefix}.bandwidthUnit`, message: `Bandwidth unit must be one of: ${BANDWIDTH_UNITS.join(', ')}`, code: 'invalid_unit' })
    }

    for (const [field, value] of [
      ['maxBandwidth', spec.maxBandwidth],
      ['maxConcurrentSession', spec.maxConcurrentSession],
      ['maxConcurrentTcpSession', spec.maxConcurrentTcpSession],
      ['maxConcurrentUdpSession', spec.maxConcurrentUdpSession],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        errors.push({ field: `${prefix}.${field}`, message: 'Value must be a non-negative integer', code: 'invalid_number' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
