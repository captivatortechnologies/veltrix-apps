import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope service object constraints -------------------------------------
// Backed by /api/v2/profiles/serviceobjects. Service objects are named
// port/protocol groups (tcp/udp/tcp_udp ranges, optionally icmp) referenced by
// firewall and steering policies. "type: PREDEFINED" objects are Netskope
// built-ins and are never matched, created or deleted by this app.

export const MAX_NAME_LENGTH = 100
const PORT_TOKEN_RE = /^\d{1,5}(-\d{1,5})?$/

export interface ServiceObjectSpec {
  itemId?: string
  /** name — the logical identity (service objects are id-addressed; the app
   *  matches on name and stores the id for rename-safety). */
  name: string
  description: string
  icmp: boolean
  /** Port numbers or ranges, e.g. "443", "8080-9090". */
  tcp: string[]
  udp: string[]
  tcpUdp: string[]
}

/** A service object as returned by GET /api/v2/profiles/serviceobjects. The
 *  `id` is a UUID string; `type` is API-computed (custom vs PREDEFINED). */
export interface LiveServiceObject {
  id?: string
  name?: string
  description?: string
  protocols?: { icmp?: boolean; tcp?: string[]; udp?: string[]; tcp_udp?: string[] }
  type?: string
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array value into trimmed, non-empty entries. */
export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveServiceObjectId(l: LiveServiceObject): string | undefined {
  return l.id === undefined || l.id === null ? undefined : String(l.id)
}

/** Netskope-managed built-in service objects — never a match target for
 *  create/update/delete by name, and never reconciled away. */
export function isPredefined(l: LiveServiceObject): boolean {
  return (l.type ?? '').toLowerCase() === 'predefined'
}

export function extractServiceObjectSpecs(canvas: CanvasSnapshot): ServiceObjectSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      icmp: f.icmp === true,
      tcp: splitEntries(f.tcp),
      udp: splitEntries(f.udp),
      tcpUdp: splitEntries(f.tcp_udp),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractServiceObjectSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate service object "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    const portFields: Array<[string, string[]]> = [
      ['tcp', spec.tcp],
      ['udp', spec.udp],
      ['tcp_udp', spec.tcpUdp],
    ]
    for (const [field, ports] of portFields) {
      ports.forEach((token, j) => {
        if (!PORT_TOKEN_RE.test(token)) {
          errors.push({ field: `${prefix}.${field}[${j}]`, message: `"${token}" is not a valid port or port range (e.g. "443" or "8080-9090")`, code: 'invalid_port' })
        }
      })
    }

    if (!spec.icmp && spec.tcp.length === 0 && spec.udp.length === 0 && spec.tcpUdp.length === 0) {
      errors.push({ field: `${prefix}.tcp`, message: 'At least one protocol (ICMP, TCP, UDP or TCP+UDP) must be set', code: 'no_protocol' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
