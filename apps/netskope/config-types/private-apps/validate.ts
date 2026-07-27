import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA private app constraints ------------------------------------

export const MAX_NAME_LENGTH = 255
const PORT_TOKEN_RE = /^\d{1,5}(-\d{1,5})?$/

export interface PrivateAppSpec {
  itemId?: string
  /** app_name — the logical identity (private apps are id-addressed; the app
   *  matches on name and stores the app id for rename-safety). */
  name: string
  /** FQDN, wildcard domain, IP address or IP subnet. */
  host: string
  /** TCP port tokens (single port or range), e.g. ["443", "8080-8090"]. */
  tcpPorts: string[]
  /** UDP port tokens. */
  udpPorts: string[]
  /** Publisher names and/or ids that steer this app; resolved at deploy. */
  publishers: string[]
  clientlessAccess: boolean
  usePublisherDns: boolean
  trustSelfSignedCerts: boolean
}

/** A private app as returned by GET /api/v2/steering/apps/private
 *  (list nested under data.private_apps). */
export interface LivePrivateApp {
  app_id?: number | string
  id?: number | string
  private_app_id?: number | string
  app_name?: string
  name?: string
  host?: string
  protocols?: Array<{ type?: string; port?: string }>
  publishers?: Array<{ publisher_id?: number | string; publisher_name?: string }>
  clientless_access?: boolean
  use_publisher_dns?: boolean
  trust_self_signed_certs?: boolean
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

/** Identity id of a live private app across the field names Netskope uses. */
export function livePrivateAppId(l: LivePrivateApp): string | undefined {
  const v = l.app_id ?? l.id ?? l.private_app_id
  return v === undefined || v === null ? undefined : String(v)
}

export function livePrivateAppName(l: LivePrivateApp): string {
  return l.app_name ?? l.name ?? ''
}

export function extractPrivateAppSpecs(canvas: CanvasSnapshot): PrivateAppSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.app_name) || item.name,
      host: asString(f.host),
      tcpPorts: splitEntries(f.tcp_ports),
      udpPorts: splitEntries(f.udp_ports),
      publishers: splitEntries(f.publishers),
      clientlessAccess: f.clientless_access === true,
      usePublisherDns: f.use_publisher_dns === true,
      trustSelfSignedCerts: f.trust_self_signed_certs === true,
    }
  })
}

function invalidPorts(tokens: string[]): string[] {
  return tokens.filter((t) => {
    if (!PORT_TOKEN_RE.test(t)) return true
    return t.split('-').some((n) => {
      const num = Number(n)
      return !Number.isInteger(num) || num < 1 || num > 65535
    })
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPrivateAppSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.app_name`, message: 'App name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.app_name`, message: `App name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.app_name`, message: `Duplicate private app "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.host) {
      errors.push({ field: `${prefix}.host`, message: 'Host is required (FQDN, wildcard domain, IP address or subnet)', code: 'required' })
    }

    if (spec.tcpPorts.length === 0 && spec.udpPorts.length === 0) {
      errors.push({ field: `${prefix}.tcp_ports`, message: 'At least one TCP or UDP port is required', code: 'no_protocol' })
    }

    const badTcp = invalidPorts(spec.tcpPorts)
    if (badTcp.length) {
      errors.push({ field: `${prefix}.tcp_ports`, message: `Invalid TCP port(s): ${badTcp.join(', ')}`, code: 'invalid_port' })
    }
    const badUdp = invalidPorts(spec.udpPorts)
    if (badUdp.length) {
      errors.push({ field: `${prefix}.udp_ports`, message: `Invalid UDP port(s): ${badUdp.join(', ')}`, code: 'invalid_port' })
    }

    if (spec.publishers.length === 0) {
      warnings.push({ field: `${prefix}.publishers`, message: 'No publishers assigned — this app will not be reachable until publishers are added', code: 'no_publishers' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
