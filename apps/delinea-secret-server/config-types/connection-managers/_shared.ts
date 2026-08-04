// Shared helpers for the Secret Server Connection Managers config type
// (deploy + rollback + drift + health). In Secret Server this is the "Site
// Connector" — the on-premises component that opens an outbound connection to
// Secret Server Cloud (or a hub Secret Server) so engines on an isolated
// network segment can be reached without an inbound firewall rule. Shapes
// follow the Secret Server v1 REST API
// (/api/v1/distributed-engine/site-connector[s]).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — New/Set/Get/Search-TssDistributedEngineSiteConnector):
//   search  GET    /api/v1/distributed-engine/site-connectors?filter.includeInactive=true
//   read    GET    /api/v1/distributed-engine/site-connector/{id}
//   create  POST   /api/v1/distributed-engine/site-connector        { data: { siteConnectorName, ... } }
//   update  PATCH  /api/v1/distributed-engine/site-connector/{id}   { data: { <field>: { dirty, value } } }
// Requires Secret Server 10.9.000064+.
//
// FLAGGED — UNVERIFIED name-field asymmetry: the module's CREATE body uses
// `siteConnectorName`, but its UPDATE body uses `name` for the same value. Both
// are honored here (create sends `siteConnectorName`; update/restore send
// `name`); a live record's name is read defensively from either key. Verify
// against a live Secret Server instance.
//
// EXCLUDED BY DESIGN: this config type never reads or calls
// GET /distributed-engine/site-connector/{id}/credentials — that endpoint
// returns the connector's own service-account username/password (secret
// material for the outbound-connection Windows service), which is
// out of scope for a PAM configuration-as-code tool.

import { listAllRecords, normalizeBool, type SecretServerClient } from '../../lib/secretServerApi'

export const CONNECTOR_TRANSPORT_TYPES = ['MemoryMq', 'RabbitMq'] as const
export type ConnectorTransportType = (typeof CONNECTOR_TRANSPORT_TYPES)[number]

/** One connector as returned by GET .../site-connector/{id} or the search records. */
export interface LiveConnector {
  id?: number | string
  siteConnectorId?: number | string
  name?: string
  siteConnectorName?: string
  hostName?: string
  active?: boolean
  useSsl?: boolean
  sslCertificateThumbprint?: string
  port?: number
  queueType?: string
  [key: string]: unknown
}

/** One connection manager (Site Connector) declared by a canvas item. */
export interface ConnectorSpec {
  name: string
  hostname: string
  transportType: ConnectorTransportType
  port: number | null
  useSsl: boolean
  sslCertificateThumbprint: string
  active: boolean
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

/** A live connector's display name — the module returns it under `name` OR `siteConnectorName` depending on the call. */
export function connectorNameOf(c: LiveConnector): string {
  return String(c.name ?? c.siteConnectorName ?? '')
}

/** A live connector's numeric id, or null when absent / non-numeric. */
export function connectorIdOf(c: LiveConnector): number | null {
  const raw = c.id ?? c.siteConnectorId
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function readOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Map canvas items to connection-manager specs. */
export function extractConnectorSpecs(items: CanvasItemLike[]): ConnectorSpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    const transport = String(f.transportType ?? 'MemoryMq').trim()
    return {
      name: String(f.name ?? '').trim(),
      hostname: String(f.hostname ?? '').trim(),
      transportType: (CONNECTOR_TRANSPORT_TYPES as readonly string[]).includes(transport)
        ? (transport as ConnectorTransportType)
        : 'MemoryMq',
      port: readOptionalInt(f.port),
      useSsl: normalizeBool(f.useSsl),
      sslCertificateThumbprint: String(f.sslCertificateThumbprint ?? '').trim(),
      active: normalizeBool(f.active),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/**
 * Search Site Connectors across every page. `filter.includeInactive=true` so a
 * disabled connector is still matched (upsert must find it). No server-side
 * name filter exists — callers match by name client-side. Throws on a non-OK
 * response.
 */
export async function searchConnectors(client: SecretServerClient): Promise<LiveConnector[]> {
  return listAllRecords<LiveConnector>(client, '/distributed-engine/site-connectors', { 'filter.includeInactive': true })
}

/** Find a live connector by name (case-insensitive), reading either name field. */
export function findConnectorByName(connectors: LiveConnector[], name: string): LiveConnector | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return connectors.find((c) => connectorNameOf(c).trim().toLowerCase() === n) ?? null
}

/** Body for POST /api/v1/distributed-engine/site-connector (create). Fields nest under `data`. */
export function buildConnectorCreateBody(spec: ConnectorSpec): Record<string, unknown> {
  const data: Record<string, unknown> = {
    siteConnectorName: spec.name,
    hostName: spec.hostname,
    queueType: spec.transportType,
    active: spec.active,
    useSsl: spec.useSsl,
  }
  if (spec.port !== null) data.port = spec.port
  if (spec.useSsl && spec.sslCertificateThumbprint) data.sslCertificateThumbprint = spec.sslCertificateThumbprint
  return { data }
}

function gridPatchBody(spec: {
  name: string
  hostname: string
  transportType: ConnectorTransportType
  active: boolean
  useSsl: boolean
  port: number | null
}): Record<string, unknown> {
  const dirty = <T,>(value: T) => ({ dirty: true, value })
  const data: Record<string, unknown> = {
    name: dirty(spec.name),
    hostName: dirty(spec.hostname),
    queueType: dirty(spec.transportType),
    active: dirty(spec.active),
    useSsl: dirty(spec.useSsl),
  }
  if (spec.port !== null) data.port = dirty(spec.port)
  return { data }
}

/** Body for PATCH /api/v1/distributed-engine/site-connector/{id} (update the managed fields). */
export function buildConnectorUpdateBody(spec: ConnectorSpec): Record<string, unknown> {
  return gridPatchBody(spec)
}

/** Restore body for a prior connector — only the fields this app manages, in the same grid-patch shape. */
export function buildConnectorRestoreBody(prior: LiveConnector): Record<string, unknown> {
  const transport = String(prior.queueType ?? 'MemoryMq')
  return gridPatchBody({
    name: connectorNameOf(prior),
    hostname: String(prior.hostName ?? ''),
    transportType: (CONNECTOR_TRANSPORT_TYPES as readonly string[]).includes(transport) ? (transport as ConnectorTransportType) : 'MemoryMq',
    active: normalizeBool(prior.active),
    useSsl: normalizeBool(prior.useSsl),
    port: typeof prior.port === 'number' ? prior.port : null,
  })
}
