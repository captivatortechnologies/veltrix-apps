// Shared helpers for the Secret Server Sites config type (deploy + rollback +
// drift + health). A "Site" is a Distributed Engine site — a named grouping
// that engines register into, carrying the engine callback/heartbeat interval,
// the WinRM/CredSSP settings engines use to run PowerShell-based password
// changing, and the optional RDP/SSH proxy engines expose. Shapes follow the
// Secret Server v1 REST API (/api/v1/distributed-engine/site[s]).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — New/Set/Get/Search-TssDistributedEngineSite):
//   search  GET    /api/v1/distributed-engine/sites?filter.siteName=<name>&filter.includeInactive=true
//   read    GET    /api/v1/distributed-engine/site/{id}
//   create  POST   /api/v1/distributed-engine/site        { data: { siteName, ... } }
//   update  PATCH  /api/v1/distributed-engine/site/{id}   { data: { <field>: { dirty, value } } }
// On-premises Secret Server requires an existing Site Connector (see the
// "Connection Managers" config type) to create a site; Secret Server Cloud
// subscriptions do not. Requires Secret Server 10.9.000064+.
//
// `powershellRunAsSecret` carries a SECRET ID REFERENCE (the secret Distributed
// Engine uses to run PowerShell-based password changing under) — never the
// secret's contents — so it is safe to manage as a plain foreign-key field,
// the same way Folders reference a parent folder by name.

import { listAllRecords, normalizeBool, type SecretServerClient } from '../../lib/secretServerApi'

/** One site as returned by GET /api/v1/distributed-engine/site/{id} or the search records. */
export interface LiveSite {
  id?: number | string
  siteId?: number | string
  siteName?: string
  active?: boolean
  heartbeatInterval?: number
  winRmEndPointUrl?: string
  siteConnectorId?: number
  enableCredSspForWinRm?: boolean
  enableRdpProxy?: boolean
  rdpProxyPort?: number
  enableSshProxy?: boolean
  sshProxyPort?: number
  powershellSecretId?: number
  [key: string]: unknown
}

/** One site declared by a canvas item. */
export interface SiteSpec {
  siteName: string
  active: boolean
  callbackInterval: number
  siteConnectorId: number
  winRmEndpoint: string
  enableCredSsp: boolean
  powershellRunAsSecretId: number | null
  enableRdpProxy: boolean
  rdpProxyPort: number | null
  enableSshProxy: boolean
  sshProxyPort: number | null
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

export function siteNameOf(s: LiveSite): string {
  return String(s.siteName ?? '')
}

/** A live site's numeric id, or null when absent / non-numeric. Some payloads key it `id`, others `siteId`. */
export function siteIdOf(s: LiveSite): number | null {
  const raw = s.id ?? s.siteId
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Read an optional positive integer field, or null when blank/invalid. */
function readOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Map canvas items to site specs. */
export function extractSiteSpecs(items: CanvasItemLike[]): SiteSpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      siteName: String(f.siteName ?? '').trim(),
      active: normalizeBool(f.active),
      callbackInterval: readOptionalInt(f.callbackInterval) ?? 300,
      siteConnectorId: readOptionalInt(f.siteConnectorId) ?? 1,
      winRmEndpoint: String(f.winRmEndpoint ?? '').trim() || 'http://localhost:5985/wsman',
      enableCredSsp: normalizeBool(f.enableCredSsp),
      powershellRunAsSecretId: readOptionalInt(f.powershellRunAsSecretId),
      enableRdpProxy: normalizeBool(f.enableRdpProxy),
      rdpProxyPort: readOptionalInt(f.rdpProxyPort),
      enableSshProxy: normalizeBool(f.enableSshProxy),
      sshProxyPort: readOptionalInt(f.sshProxyPort),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/**
 * Search Distributed Engine sites, optionally filtered by a partial name match,
 * across every page. `filter.includeInactive=true` so a disabled site is still
 * matched (upsert must find it). Throws on a non-OK response.
 */
export async function searchSites(client: SecretServerClient, name?: string): Promise<LiveSite[]> {
  const query: Record<string, string | number | boolean> = { 'filter.includeInactive': true }
  if (name) query['filter.siteName'] = name
  return listAllRecords<LiveSite>(client, '/distributed-engine/sites', query)
}

/** Find a live site by exact name (case-insensitive) — search is a partial match, so callers must narrow. */
export function findSiteByName(sites: LiveSite[], name: string): LiveSite | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return sites.find((s) => siteNameOf(s).trim().toLowerCase() === n) ?? null
}

/** Body for POST /api/v1/distributed-engine/site (create). Fields nest under `data`. */
export function buildSiteCreateBody(spec: SiteSpec): Record<string, unknown> {
  const data: Record<string, unknown> = {
    siteName: spec.siteName,
    active: spec.active,
    heartbeatInterval: spec.callbackInterval,
    winRmEndPointUrl: spec.winRmEndpoint,
    siteConnectorId: spec.siteConnectorId,
    enableCredSspForWinRm: spec.enableCredSsp,
    enableRdpProxy: spec.enableRdpProxy,
    enableSshProxy: spec.enableSshProxy,
  }
  if (spec.rdpProxyPort !== null) data.rdpProxyPort = spec.rdpProxyPort
  if (spec.sshProxyPort !== null) data.sshProxyPort = spec.sshProxyPort
  if (spec.powershellRunAsSecretId !== null) data.powershellSecretId = spec.powershellRunAsSecretId
  return { data }
}

/** Wrap every managed field in the grid-patch `{ dirty, value }` shape shared by update + restore. */
function gridPatchBody(spec: {
  siteName: string
  active: boolean
  callbackInterval: number
  siteConnectorId: number
  winRmEndpoint: string
  enableCredSsp: boolean
  enableRdpProxy: boolean
  rdpProxyPort: number | null
  enableSshProxy: boolean
  sshProxyPort: number | null
  powershellRunAsSecretId: number | null
}): Record<string, unknown> {
  const dirty = <T,>(value: T) => ({ dirty: true, value })
  const data: Record<string, unknown> = {
    siteName: dirty(spec.siteName),
    active: dirty(spec.active),
    heartbeatInterval: dirty(spec.callbackInterval),
    winRmEndPointUrl: dirty(spec.winRmEndpoint),
    siteConnectorId: dirty(spec.siteConnectorId),
    enableCredSspForWinRm: dirty(spec.enableCredSsp),
    enableRdpProxy: dirty(spec.enableRdpProxy),
    enableSshProxy: dirty(spec.enableSshProxy),
  }
  data.rdpProxyPort = dirty(spec.rdpProxyPort ?? 0)
  data.sshProxyPort = dirty(spec.sshProxyPort ?? 0)
  if (spec.powershellRunAsSecretId !== null) data.powershellSecretId = dirty(spec.powershellRunAsSecretId)
  return { data }
}

/** Body for PATCH /api/v1/distributed-engine/site/{id} (update the managed fields). */
export function buildSiteUpdateBody(spec: SiteSpec): Record<string, unknown> {
  return gridPatchBody(spec)
}

/** Restore body for a prior site — only the fields this app manages, in the same grid-patch shape. */
export function buildSiteRestoreBody(prior: LiveSite): Record<string, unknown> {
  return gridPatchBody({
    siteName: String(prior.siteName ?? ''),
    active: normalizeBool(prior.active),
    callbackInterval: typeof prior.heartbeatInterval === 'number' ? prior.heartbeatInterval : 300,
    siteConnectorId: typeof prior.siteConnectorId === 'number' ? prior.siteConnectorId : 1,
    winRmEndpoint: String(prior.winRmEndPointUrl ?? 'http://localhost:5985/wsman'),
    enableCredSsp: normalizeBool(prior.enableCredSspForWinRm),
    enableRdpProxy: normalizeBool(prior.enableRdpProxy),
    rdpProxyPort: typeof prior.rdpProxyPort === 'number' ? prior.rdpProxyPort : null,
    enableSshProxy: normalizeBool(prior.enableSshProxy),
    sshProxyPort: typeof prior.sshProxyPort === 'number' ? prior.sshProxyPort : null,
    powershellRunAsSecretId: typeof prior.powershellSecretId === 'number' ? prior.powershellSecretId : null,
  })
}
