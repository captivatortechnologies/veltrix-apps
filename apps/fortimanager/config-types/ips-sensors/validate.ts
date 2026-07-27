import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager IPS sensor constraints -------------------------------------

export const MAX_NAME_LENGTH = 35
export const BOTNET_ACTIONS = ['disable', 'block', 'monitor'] as const

export interface IpsSensorSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  /** enable | disable */
  blockMaliciousUrl: string
  /** enable | disable */
  extendedLog: string
  /** disable | block | monitor */
  scanBotnetConnections: string
  /** Raw JSON for the entries list (validated to parse to an array). */
  entries: string
}

/** An IPS sensor as returned by a get on the ips/sensor table. */
export interface LiveIpsSensor {
  name?: string
  comment?: string
  'block-malicious-url'?: string | number
  'extended-log'?: string | number
  'scan-botnet-connections'?: string | number
  entries?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asToggle(v: unknown, dflt: 'enable' | 'disable' = 'disable'): string {
  if (v === true || v === 'enable' || v === 'true') return 'enable'
  return dflt
}

export interface ParsedJson {
  ok: boolean
  value?: unknown
}

/** Parse a JSON textarea value. An empty value is valid (undefined). */
export function parseJsonField(raw: string): ParsedJson {
  const t = raw.trim()
  if (!t) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false }
  }
}

export function extractIpsSensorSpecs(canvas: CanvasSnapshot): IpsSensorSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      blockMaliciousUrl: asToggle(f.blockMaliciousUrl),
      extendedLog: asToggle(f.extendedLog),
      scanBotnetConnections: (asString(f.scanBotnetConnections) || 'disable').toLowerCase(),
      entries: typeof f.entries === 'string' ? f.entries : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIpsSensorSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate IPS sensor "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(BOTNET_ACTIONS as readonly string[]).includes(spec.scanBotnetConnections)) {
      errors.push({ field: `${prefix}.scanBotnetConnections`, message: `Scan botnet connections must be one of: ${BOTNET_ACTIONS.join(', ')}`, code: 'invalid_botnet_action' })
    }

    const parsed = parseJsonField(spec.entries)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.entries`, message: 'Entries must be valid JSON', code: 'invalid_json' })
    } else if (parsed.value !== undefined && !Array.isArray(parsed.value)) {
      errors.push({ field: `${prefix}.entries`, message: 'Entries must be a JSON array', code: 'invalid_json_shape' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
