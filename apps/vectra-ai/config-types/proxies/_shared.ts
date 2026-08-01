// Shared helpers for the Vectra Proxies config type (deploy + rollback + drift).
//
// Proxy shapes follow the Vectra Detect v2.x REST API (/api/v2.5/proxies), as
// exercised by Vectra's official client `vectra_api_tools` (VectraClientV2):
//   list:   GET    /proxies            → { proxies: [ {proxy} ] } (or DRF { results })
//   get:    GET    /proxies/{id}
//   create: POST   /proxies            body { proxy: { address, considerProxy } }
//   update: PATCH  /proxies/{id}       body { proxy: { address?, considerProxy? } }
//   delete: DELETE /proxies/{id}
//
// A proxy tells Vectra that an internal IP is a proxy so detections are attributed
// to the real client behind it rather than the proxy. `considerProxy` toggles that
// behaviour. The proxy `address` (an internal IP) is the stable identity here.
//
// FLAG (verify against a live Vectra): the exact list envelope key (`proxies` vs a
// DRF `results`) and whether list items nest the fields under `proxy` or flatten
// them — both shapes are read defensively below.

/** One Vectra proxy, tolerant of the create/list envelope variations. */
export interface VectraProxy {
  id?: number | string
  address?: string
  considerProxy?: boolean
  proxy?: { id?: number | string; address?: string; considerProxy?: boolean }
  [key: string]: unknown
}

/** Coerce a canvas/Vectra value that may be a boolean, 1|0 or 'true'/'false' string. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  return false
}

/** The proxy id, from a bare object or a `{ proxy: {...} }` wrapper. */
export function idOfProxy(p: VectraProxy | null): number | string | null {
  return p?.id ?? p?.proxy?.id ?? null
}

/** The proxy address, whether flattened on the item or nested under `proxy`. */
export function addressOf(p: VectraProxy): string {
  return String(p.address ?? p.proxy?.address ?? '').trim()
}

/** The considerProxy flag, whether flattened on the item or nested under `proxy`. */
export function considerProxyOf(p: VectraProxy): boolean {
  return normalizeBool(p.considerProxy ?? p.proxy?.considerProxy)
}

/** Unwrap the Vectra list envelope (`{ proxies: [...] }` or DRF `{ results }`). */
export function proxiesFromList(list: unknown): VectraProxy[] {
  if (Array.isArray(list)) return list as VectraProxy[]
  if (list && typeof list === 'object') {
    const o = list as { proxies?: unknown; results?: unknown }
    if (Array.isArray(o.proxies)) return o.proxies as VectraProxy[]
    if (Array.isArray(o.results)) return o.results as VectraProxy[]
  }
  return []
}

/** Find a live proxy by its address (the stable identity used for upsert/drift). */
export function findProxy(proxies: VectraProxy[], address: string): VectraProxy | null {
  const a = address.trim()
  if (!a) return null
  return proxies.find((p) => addressOf(p) === a) ?? null
}

/** Build the Vectra proxy body: `{ proxy: { address, considerProxy } }`. */
export function buildProxyBody(fields: Record<string, unknown>): { proxy: { address: string; considerProxy: boolean } } {
  return {
    proxy: {
      address: String(fields.address ?? '').trim(),
      considerProxy: normalizeBool(fields.considerProxy),
    },
  }
}
