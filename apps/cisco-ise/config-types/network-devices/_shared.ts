// Shared helpers for the Network Devices config type (validate + deploy +
// rollback + drift). Field shapes follow the ISE ERS NetworkDevice resource
// (/ers/config/networkdevice) — verified against the community pyise-ers ERS
// client (github.com/falkowich/pyise-ers, pyiseers/pyiseers.py: add_device /
// get_device). IPv4 only; TACACS+ and SNMP settings are intentionally not
// implemented (see the app README).

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { NetworkDevice, NetworkDeviceIp } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000
/** ISE requires every device to belong to a Location and a Device Type NDG. */
export const DEFAULT_DEVICE_GROUPS = ['Location#All Locations', 'Device Type#All Device Types']
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIPv4(value: string): boolean {
  const m = IPV4_RE.exec(value.trim())
  if (!m) return false
  return m.slice(1, 5).every((octet) => Number(octet) <= 255)
}

/**
 * Parse the `ip_addresses` canvas keyvalue field into ip/mask pairs. The
 * platform's keyvalue control can serialize as either an array of `{key,value}`
 * (or `{name,value}`) objects or a plain `{ [key]: value }` object — this
 * tolerates both. A missing/invalid mask defaults to /32 (a single host).
 */
export function readIpMaskEntries(value: unknown): NetworkDeviceIp[] {
  const out: NetworkDeviceIp[] = []
  const push = (ipRaw: unknown, maskRaw: unknown) => {
    const ipaddress = String(ipRaw ?? '').trim()
    if (!ipaddress) return
    // Only a missing/non-numeric mask defaults to /32 — an out-of-range value
    // (e.g. 99) is preserved as-is so validate.ts can reject it rather than
    // silently coercing a typo into a valid-looking mask.
    const mask = Number(maskRaw)
    out.push({ ipaddress, mask: Number.isFinite(mask) ? mask : 32 })
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === 'object') {
        const rec = entry as Record<string, unknown>
        push(rec.key ?? rec.name, rec.value)
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) push(k, v)
  }
  return out
}

/** Parse the `device_groups` canvas tags field into a trimmed string list. */
export function readTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

/** One network device item, normalized from canvas fields. */
export interface DeviceSpec {
  name: string
  description: string
  ipEntries: NetworkDeviceIp[]
  deviceGroups: string[]
  /** '' = not provided this deploy — never touch the live secret (write-only). */
  radiusSharedSecret: string
}

export function specFromItem(item: CanvasItemSnapshot): DeviceSpec {
  const deviceGroups = readTagList(item.fields.device_groups)
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    ipEntries: readIpMaskEntries(item.fields.ip_addresses),
    deviceGroups: deviceGroups.length > 0 ? deviceGroups : [...DEFAULT_DEVICE_GROUPS],
    radiusSharedSecret: String(item.fields.radius_shared_secret ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): DeviceSpec[] {
  return items.map(specFromItem)
}

/**
 * The ERS create/update body for a spec. `authenticationSettings` is OMITTED
 * ENTIRELY when no secret was provided this deploy — ISE cannot echo the
 * secret back for us to compare, so an absent value must never be conflated
 * with "clear it"; only an explicit non-blank entry ever touches RADIUS auth.
 */
export function toNetworkDeviceBody(spec: DeviceSpec): Omit<NetworkDevice, 'id' | 'link'> {
  const body: Omit<NetworkDevice, 'id' | 'link'> = {
    name: spec.name,
    description: spec.description,
    NetworkDeviceIPList: spec.ipEntries,
    NetworkDeviceGroupList: spec.deviceGroups,
  }
  if (spec.radiusSharedSecret) {
    body.authenticationSettings = { networkProtocol: 'RADIUS', radiusSharedSecret: spec.radiusSharedSecret, enableKeyWrap: 'false' }
  }
  return body
}

/**
 * Strip anything secret-shaped before a live device is persisted into
 * rollbackData. Defense in depth — ERS should never echo `radiusSharedSecret`
 * on GET, but this guarantees it can never land in stored rollback state even
 * if a future ISE version changes that behavior.
 */
export function stripSecrets(device: NetworkDevice): NetworkDevice {
  const { authenticationSettings, ...rest } = device
  void authenticationSettings
  return rest
}

/** Build the restore body from a captured prior device — NEVER re-asserts a
 *  secret (it was stripped before capture; see stripSecrets). */
export function toRestoreBody(prior: NetworkDevice, fallbackName: string): Omit<NetworkDevice, 'id' | 'link'> {
  return {
    name: prior.name ?? fallbackName,
    description: prior.description ?? '',
    NetworkDeviceIPList: prior.NetworkDeviceIPList ?? [],
    NetworkDeviceGroupList: prior.NetworkDeviceGroupList ?? [...DEFAULT_DEVICE_GROUPS],
  }
}
