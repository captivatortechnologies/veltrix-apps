// Shared helpers for the Cisco Umbrella Network Tunnels config type
// (validate + deploy + rollback + drift).
//
// A Network Tunnel (/deployments/v2/tunnels) is an IPsec (or GRE) tunnel
// Umbrella uses to onramp traffic to its Secure Internet Gateway. Confirmed
// endpoints: GET (list), POST (create), DELETE — no PUT/PATCH (update) was
// found in ANY reference (Cisco's official external Postman collection, the
// community `josgabfer/UmbrellaAPI` scripts, or Cisco's Refit-based client).
// A tunnel is therefore treated as IMMUTABLE after create: this app can only
// create it or delete it, never edit it in place — recreate (delete + declare
// again) to change a field. Shapes follow:
//   - Cisco's official Postman example ("Add a Tunnel"): { name, deviceType,
//     authentication: { type: "PSK", parameters: { secret, idPrefix } },
//     serviceType: "SIG", siteOriginId }
//   - josgabfer/UmbrellaAPI's create_tunnels.py (working sample): the same
//     name/deviceType/authentication shape (using "transport.protocol" instead
//     of serviceType — kept here as an unverified variant, not sent).
// NOT independently re-verified against a live tenant: the exact response
// shape (one community sample nests deviceType/authentication under a
// top-level "client" key on the object Umbrella returns).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { DEPLOYMENTS_SITES_PATH, DEPLOYMENTS_TUNNELS_PATH, listDeployment } from '../../lib/deployments'
import type { LiveResource } from '../../lib/deployments'
import type { UmbrellaClient } from '../../lib/umbrellaApi'

export const MAX_NAME_LENGTH = 50
export const MIN_SECRET_LENGTH = 8
export const DEFAULT_DEVICE_TYPE = 'other'

/** One tunnel declared on the canvas (one item). */
export interface TunnelSpec {
  itemId?: string
  /** name — the logical identity (Umbrella tunnels are id-addressed). */
  name: string
  /** Free text — Cisco has not published a closed enum; "other" is the
   * only value confirmed working in every reference sample. */
  deviceType: string
  /** Write-only PSK secret — Umbrella never returns it, so it cannot be
   * diffed, logged, or captured for rollback. */
  pskSecret: string
  idPrefix: string
  /** Optional Site name this tunnel is bound to (resolved to siteOriginId). */
  siteName: string
}

/** A tunnel as returned by GET /deployments/v2/tunnels (best-effort — one
 * community sample nests client config under "client"). */
export interface LiveTunnel extends LiveResource {
  id?: number | string
  name?: string
  deviceType?: string
  client?: {
    deviceType?: string
    authentication?: { parameters?: { idPrefix?: string; id?: number | string } }
  }
  meta?: { state?: { status?: string } }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractTunnelSpecs(canvas: CanvasSnapshot): TunnelSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    deviceType: asString(item.fields?.deviceType) || DEFAULT_DEVICE_TYPE,
    pskSecret: typeof item.fields?.pskSecret === 'string' ? item.fields.pskSecret : '',
    idPrefix: asString(item.fields?.idPrefix),
    siteName: asString(item.fields?.siteName),
  }))
}

/** The live tunnel's reported device type, tolerating both the flat and the
 * "client.deviceType"-nested shape. */
export function liveDeviceType(live: LiveTunnel): string {
  return asString(live.deviceType) || asString(live.client?.deviceType)
}

/** Build the POST /deployments/v2/tunnels create body. `siteOriginId` is only
 * sent when a site association was declared and successfully resolved. */
export function tunnelCreateBody(spec: TunnelSpec, siteOriginId?: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    deviceType: spec.deviceType,
    authentication: {
      type: 'PSK',
      parameters: {
        secret: spec.pskSecret,
        ...(spec.idPrefix ? { idPrefix: spec.idPrefix } : {}),
      },
    },
    serviceType: 'SIG',
  }
  if (siteOriginId != null) body.siteOriginId = siteOriginId
  return body
}

/** Resolve a declared site NAME to its opaque siteId, or undefined if blank /
 * not found (best-effort — a tunnel can be declared with no site association). */
export async function resolveSiteOriginId(client: UmbrellaClient, siteName: string): Promise<number | undefined> {
  if (!siteName) return undefined
  const listed = await listDeployment(client, DEPLOYMENTS_SITES_PATH)
  if (!listed.ok) return undefined
  const match = listed.items.find((l) => asString((l as Record<string, unknown>).name).toLowerCase() === siteName.toLowerCase())
  const raw = (match as Record<string, unknown> | undefined)?.siteId ?? (match as Record<string, unknown> | undefined)?.originId
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) ? n : undefined
}
