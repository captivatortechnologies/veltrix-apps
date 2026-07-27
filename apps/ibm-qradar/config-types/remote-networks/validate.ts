import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar remote-network constraints -----------------------------------

export interface RemoteNetworkSpec {
  itemId?: string
  /** name — the remote network's natural identity (matched by name, rename-safe by id). */
  name: string
  description: string
  group: string
  cidrs: string[]
}

/** A remote network as returned by GET /staged_config/remote_networks. */
export interface LiveRemoteNetwork {
  id?: number
  name?: string
  description?: string
  group?: string
  cidrs?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array into trimmed, non-empty, de-duplicated CIDR entries. */
export function splitCidrs(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractRemoteNetworkSpecs(canvas: CanvasSnapshot): RemoteNetworkSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      group: asString(f.group),
      cidrs: splitCidrs(f.cidrs),
    }
  })
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/

export function isValidCidr(value: string): boolean {
  if (value.includes(':')) return true // permissive for IPv6
  const m = CIDR.exec(value)
  if (!m) return false
  if (![1, 2, 3, 4].every((i) => Number(m[i]) <= 255)) return false
  if (m[5] !== undefined && Number(m[5]) > 32) return false
  return true
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRemoteNetworkSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate remote network "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    spec.cidrs.forEach((c, ci) => {
      if (!isValidCidr(c)) errors.push({ field: `${prefix}.cidrs[${ci}]`, message: `"${c}" is not a valid CIDR range`, code: 'invalid_cidr' })
    })

    if (spec.cidrs.length === 0) {
      warnings.push({ field: `${prefix}.cidrs`, message: 'This remote network has no CIDR ranges', code: 'empty_cidrs' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
