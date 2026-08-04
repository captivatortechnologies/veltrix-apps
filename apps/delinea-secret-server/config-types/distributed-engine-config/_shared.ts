// Shared helpers for the Secret Server Distributed Engine Configuration
// singleton (deploy + rollback + drift). This is the tenant-wide feature
// toggle + messaging settings for Distributed Engine (NOT a specific site or
// engine — see the "Sites" and "Connection Managers" configuration types for
// those). Shapes follow the Secret Server v1 REST API
// (/api/v1/distributed-engine/configuration).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — Get/Set-TssDistributedEngine):
//   read    GET   /api/v1/distributed-engine/configuration
//   update  PATCH /api/v1/distributed-engine/configuration   { data: { <field>: { dirty, value } } }
// There is no create/delete — this object always exists on a Secret Server
// instance. No secret material — feature flags, ports/URLs and message
// timing. Requires Secret Server 10.9.000064+.

import { normalizeBool } from '../../lib/secretServerApi'

export const ENGINE_PROTOCOLS = ['Http', 'Https', 'Tcp'] as const
export type EngineProtocol = (typeof ENGINE_PROTOCOLS)[number]

export const AZURE_SERVICE_BUS_TRANSPORT_TYPES = ['Amqp', 'AmqpWebSockets'] as const
export type AzureServiceBusTransportType = (typeof AZURE_SERVICE_BUS_TRANSPORT_TYPES)[number]

/** The live configuration as returned by GET /api/v1/distributed-engine/configuration. */
export interface LiveDistributedEngineConfig {
  enableDistributedEngines?: boolean
  azureServiceBusTransportType?: string
  callbackPort?: number
  callbackUrl?: string
  protocol?: string
  responseBusSiteConnectorId?: number
  secretHeartbeatMessageMinutesToLive?: number
  secretHeartbeatMessageRetryMinutes?: number
  secretPasswordChangeMessageMinutesToLive?: number
  secretPasswordChangeMessageRetryMinutes?: number
  [key: string]: unknown
}

/** The singleton configuration declared by the (single) canvas item. */
export interface DistributedEngineConfigSpec {
  enabled: boolean
  azureServiceBusTransportType: AzureServiceBusTransportType
  callbackPort: number | null
  callbackUrl: string
  protocol: EngineProtocol
  responseBusSiteConnectorId: number | null
  heartbeatTimeToLive: number | null
  heartbeatRetry: number | null
  rpcTimeToLive: number | null
  rpcRetry: number | null
}

function readOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Read the singleton spec from the (only) canvas item's fields — defaults mirror Secret Server's own. */
export function extractDistributedEngineConfigSpec(fields: Record<string, unknown>): DistributedEngineConfigSpec {
  const protocol = String(fields.protocol ?? 'Https').trim()
  const azTransport = String(fields.azureServiceBusTransportType ?? 'Amqp').trim()
  return {
    enabled: normalizeBool(fields.enabled),
    azureServiceBusTransportType: (AZURE_SERVICE_BUS_TRANSPORT_TYPES as readonly string[]).includes(azTransport)
      ? (azTransport as AzureServiceBusTransportType)
      : 'Amqp',
    callbackPort: readOptionalInt(fields.callbackPort),
    callbackUrl: String(fields.callbackUrl ?? '').trim(),
    protocol: (ENGINE_PROTOCOLS as readonly string[]).includes(protocol) ? (protocol as EngineProtocol) : 'Https',
    responseBusSiteConnectorId: readOptionalInt(fields.responseBusSiteConnectorId),
    heartbeatTimeToLive: readOptionalInt(fields.heartbeatTimeToLive),
    heartbeatRetry: readOptionalInt(fields.heartbeatRetry),
    rpcTimeToLive: readOptionalInt(fields.rpcTimeToLive),
    rpcRetry: readOptionalInt(fields.rpcRetry),
  }
}

/** Wrap every managed field in the grid-patch `{ dirty, value }` shape — shared by update + restore. */
export function buildDistributedEngineConfigPatchBody(spec: DistributedEngineConfigSpec): Record<string, unknown> {
  const dirty = <T,>(value: T) => ({ dirty: true, value })
  const data: Record<string, unknown> = {
    enableDistributedEngines: dirty(spec.enabled),
    azureServiceBusTransportType: dirty(spec.azureServiceBusTransportType),
    protocol: dirty(spec.protocol),
  }
  if (spec.callbackPort !== null) data.callbackPort = dirty(spec.callbackPort)
  if (spec.callbackUrl) data.callbackUrl = dirty(spec.callbackUrl)
  if (spec.responseBusSiteConnectorId !== null) data.responseBusSiteConnectorId = dirty(spec.responseBusSiteConnectorId)
  if (spec.heartbeatTimeToLive !== null) data.secretHeartbeatMessageMinutesToLive = dirty(spec.heartbeatTimeToLive)
  if (spec.heartbeatRetry !== null) data.secretHeartbeatMessageRetryMinutes = dirty(spec.heartbeatRetry)
  if (spec.rpcTimeToLive !== null) data.secretPasswordChangeMessageMinutesToLive = dirty(spec.rpcTimeToLive)
  if (spec.rpcRetry !== null) data.secretPasswordChangeMessageRetryMinutes = dirty(spec.rpcRetry)
  return { data }
}

/** Build the same grid-patch body from a live/prior configuration snapshot, for rollback. */
export function buildDistributedEngineConfigRestoreBody(prior: LiveDistributedEngineConfig): Record<string, unknown> {
  const protocol = String(prior.protocol ?? 'Https')
  const azTransport = String(prior.azureServiceBusTransportType ?? 'Amqp')
  return buildDistributedEngineConfigPatchBody({
    enabled: normalizeBool(prior.enableDistributedEngines),
    azureServiceBusTransportType: (AZURE_SERVICE_BUS_TRANSPORT_TYPES as readonly string[]).includes(azTransport)
      ? (azTransport as AzureServiceBusTransportType)
      : 'Amqp',
    callbackPort: typeof prior.callbackPort === 'number' ? prior.callbackPort : null,
    callbackUrl: String(prior.callbackUrl ?? ''),
    protocol: (ENGINE_PROTOCOLS as readonly string[]).includes(protocol) ? (protocol as EngineProtocol) : 'Https',
    responseBusSiteConnectorId: typeof prior.responseBusSiteConnectorId === 'number' ? prior.responseBusSiteConnectorId : null,
    heartbeatTimeToLive: typeof prior.secretHeartbeatMessageMinutesToLive === 'number' ? prior.secretHeartbeatMessageMinutesToLive : null,
    heartbeatRetry: typeof prior.secretHeartbeatMessageRetryMinutes === 'number' ? prior.secretHeartbeatMessageRetryMinutes : null,
    rpcTimeToLive: typeof prior.secretPasswordChangeMessageMinutesToLive === 'number' ? prior.secretPasswordChangeMessageMinutesToLive : null,
    rpcRetry: typeof prior.secretPasswordChangeMessageRetryMinutes === 'number' ? prior.secretPasswordChangeMessageRetryMinutes : null,
  })
}
