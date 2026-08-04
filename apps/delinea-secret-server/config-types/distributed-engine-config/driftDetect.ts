import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, normalizeBool, parseJson } from '../../lib/secretServerApi'
import { extractDistributedEngineConfigSpec, type LiveDistributedEngineConfig } from './_shared'

/**
 * Drift for the Distributed Engine configuration singleton: compare every
 * field the operator actually declared against the live GET
 * /distributed-engine/configuration. A blank optional field is never compared
 * (this app never claimed to own it). Best-effort — a read error yields no
 * drift, not a failure. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const item = items[0]
  if (!item) return { hasDrift: false, diffs }

  const spec = extractDistributedEngineConfigSpec(item.fields ?? {})

  let live: LiveDistributedEngineConfig
  try {
    const res = await client.request('GET', '/distributed-engine/configuration')
    if (!res.ok) return { hasDrift: false, diffs }
    live = parseJson<LiveDistributedEngineConfig>(res.body) ?? {}
  } catch {
    return { hasDrift: false, diffs }
  }

  if (live.enableDistributedEngines !== undefined && normalizeBool(live.enableDistributedEngines) !== spec.enabled) {
    diffs.push({ field: 'enabled', expected: spec.enabled, actual: normalizeBool(live.enableDistributedEngines), severity: 'warning' })
  }
  if (live.protocol !== undefined && String(live.protocol) !== spec.protocol) {
    diffs.push({ field: 'protocol', expected: spec.protocol, actual: String(live.protocol), severity: 'warning' })
  }
  if (live.azureServiceBusTransportType !== undefined && String(live.azureServiceBusTransportType) !== spec.azureServiceBusTransportType) {
    diffs.push({
      field: 'azureServiceBusTransportType',
      expected: spec.azureServiceBusTransportType,
      actual: String(live.azureServiceBusTransportType),
      severity: 'warning',
    })
  }
  if (spec.callbackPort !== null && live.callbackPort !== undefined && live.callbackPort !== spec.callbackPort) {
    diffs.push({ field: 'callbackPort', expected: spec.callbackPort, actual: live.callbackPort, severity: 'warning' })
  }
  if (spec.callbackUrl && live.callbackUrl !== undefined && String(live.callbackUrl) !== spec.callbackUrl) {
    diffs.push({ field: 'callbackUrl', expected: spec.callbackUrl, actual: String(live.callbackUrl), severity: 'warning' })
  }
  if (
    spec.responseBusSiteConnectorId !== null &&
    live.responseBusSiteConnectorId !== undefined &&
    live.responseBusSiteConnectorId !== spec.responseBusSiteConnectorId
  ) {
    diffs.push({
      field: 'responseBusSiteConnectorId',
      expected: spec.responseBusSiteConnectorId,
      actual: live.responseBusSiteConnectorId,
      severity: 'warning',
    })
  }
  if (
    spec.heartbeatTimeToLive !== null &&
    live.secretHeartbeatMessageMinutesToLive !== undefined &&
    live.secretHeartbeatMessageMinutesToLive !== spec.heartbeatTimeToLive
  ) {
    diffs.push({
      field: 'heartbeatTimeToLive',
      expected: spec.heartbeatTimeToLive,
      actual: live.secretHeartbeatMessageMinutesToLive,
      severity: 'warning',
    })
  }
  if (
    spec.heartbeatRetry !== null &&
    live.secretHeartbeatMessageRetryMinutes !== undefined &&
    live.secretHeartbeatMessageRetryMinutes !== spec.heartbeatRetry
  ) {
    diffs.push({ field: 'heartbeatRetry', expected: spec.heartbeatRetry, actual: live.secretHeartbeatMessageRetryMinutes, severity: 'warning' })
  }
  if (
    spec.rpcTimeToLive !== null &&
    live.secretPasswordChangeMessageMinutesToLive !== undefined &&
    live.secretPasswordChangeMessageMinutesToLive !== spec.rpcTimeToLive
  ) {
    diffs.push({ field: 'rpcTimeToLive', expected: spec.rpcTimeToLive, actual: live.secretPasswordChangeMessageMinutesToLive, severity: 'warning' })
  }
  if (
    spec.rpcRetry !== null &&
    live.secretPasswordChangeMessageRetryMinutes !== undefined &&
    live.secretPasswordChangeMessageRetryMinutes !== spec.rpcRetry
  ) {
    diffs.push({ field: 'rpcRetry', expected: spec.rpcRetry, actual: live.secretPasswordChangeMessageRetryMinutes, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
