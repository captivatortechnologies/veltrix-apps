import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asArray, barracudaErrorMessage, readBool, readString, type BarracudaWaasClient } from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service DDoS Allow List constraints -------------------
//
// A collection resource of the Application:
//   GET/POST     /applications/{appName}/ddos/allow_list/
//   PATCH/DELETE /applications/{appName}/ddos/allow_list/{id}/  ({id} server-assigned)
// Every field (ip, netmask, note, allow_bypass) is confirmed directly against
// the live API's request-body example (api.waas.barracudanetworks.com/v4/
// swagger/, operation addIpToDDoSAllowList). Identity for reconciliation is
// the `ip` value — the numeric `id` used in the PATCH/DELETE path is resolved
// by listing and matching.

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

export interface DdosAllowListSpec {
  sectionName: string
  ip: string
  netmask: string
  note: string
  allowBypass: boolean
}

/** Each canvas item describes one DDoS allow-list entry. */
export function extractDdosAllowListSpecs(canvas: CanvasSnapshot): DdosAllowListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      ip: readString(fields.ip),
      netmask: readString(fields.netmask) || '255.255.255.255',
      note: readString(fields.note),
      allowBypass: readBool(fields.allow_bypass, false),
    }
  })
}

/** The entry's identity key — its IP address. */
export function allowListKey(ip: string): string {
  return ip.trim()
}

/** Shape of an entry returned by GET /applications/{appName}/ddos/allow_list/. */
export interface LiveAllowListEntry {
  id?: number | string
  ip?: string
  netmask?: string
  note?: string
  allow_bypass?: boolean
}

/** Build the POST/PATCH request body for a declared allow-list entry. */
export function buildAllowListBody(spec: DdosAllowListSpec): Record<string, unknown> {
  return { ip: spec.ip, netmask: spec.netmask, note: spec.note, allow_bypass: spec.allowBypass }
}

/** List every entry in the Application's DDoS allow list (follows pagination); throws on a non-OK response. */
export async function listAllowList(client: BarracudaWaasClient, appName: string): Promise<LiveAllowListEntry[]> {
  const res = await client.listAll<LiveAllowListEntry>(`${client.appPath(appName)}/ddos/allow_list/`)
  if (!res.ok) throw new Error(`Failed to list the DDoS allow list: ${barracudaErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  return res.items.length ? res.items : asArray<LiveAllowListEntry>(res.body)
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate DDoS Allow List entries: the IP is required and a valid IPv4
 * address, the netmask (when set) is a valid IPv4 dotted mask, and the IP is
 * unique across the canvas (deploy matches on it).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDdosAllowListSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ip) {
      errors.push({ field: `${prefix}.ip`, message: 'IP Address is required', code: 'required' })
    } else if (!IPV4_RE.test(spec.ip)) {
      errors.push({ field: `${prefix}.ip`, message: `"${spec.ip}" is not a valid IPv4 address`, code: 'invalid_ip' })
    } else {
      const key = allowListKey(spec.ip)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.ip`, message: `Duplicate IP "${spec.ip}" — each entry may only be declared once`, code: 'duplicate_ip' })
      }
      seen.add(key)
    }

    if (spec.netmask && !IPV4_RE.test(spec.netmask)) {
      errors.push({ field: `${prefix}.netmask`, message: `"${spec.netmask}" is not a valid IPv4 netmask`, code: 'invalid_netmask' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
