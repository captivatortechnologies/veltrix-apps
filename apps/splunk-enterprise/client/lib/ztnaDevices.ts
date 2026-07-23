// Shared ZTNA tailnet device helpers — used by both the Access Servers table
// (live connectivity dot) and the per-server detail modal. Kept in one place so
// the hostname-matching heuristic (which must survive Tailscale's hostname
// rewrite) never drifts between the two surfaces.

// The one ZTNA provider type the platform operates itself (a managed Tailscale
// tailnet). Only this type has live tailnet device status to show a connectivity
// dot for; BYO providers are reached however that provider is configured.
export const MANAGED_PROVIDER_TYPE = 'veltrix_managed'

export interface ZtnaDeviceSummary {
  id: string
  name: string
  hostname: string
  addresses: string[]
  online: boolean
  lastSeen?: string
  customerTag?: string | null
}

// Tailscale derives a device's name from the machine's hostname: it lowercases,
// strips a trailing `.local`, and turns any other punctuation into hyphens — so a
// server hostname like `splunk-sh1.babong.local` joins the tailnet as the device
// `splunk-sh1-babong`. Normalize the same way so a match survives that rewrite.
export function tailscaleName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// The first DNS label of a value (`splunk-sh1-babong.tailnet.ts.net` → `splunk-sh1-babong`).
export function firstLabel(value: string): string {
  return value.toLowerCase().split('.')[0]
}

// Resolves an access server to its tailnet device by hostname/name,
// case-insensitively and tolerant of Tailscale's hostname sanitization. A
// device's `name` is often a MagicDNS FQDN (`<label>.<tailnet>.ts.net`), so its
// first label is compared too.
export function matchDevice(hostname: string, devices: ZtnaDeviceSummary[]): ZtnaDeviceSummary | null {
  const host = hostname.toLowerCase()
  const wanted = tailscaleName(hostname)
  return (
    devices.find((d) => {
      const dHostname = (d.hostname ?? '').toLowerCase()
      const dName = (d.name ?? '').toLowerCase()
      if (dHostname === host || dName === host || dName.startsWith(`${host}.`)) return true
      return (
        tailscaleName(dHostname) === wanted ||
        firstLabel(dName) === wanted ||
        tailscaleName(dName) === wanted
      )
    }) ?? null
  )
}
