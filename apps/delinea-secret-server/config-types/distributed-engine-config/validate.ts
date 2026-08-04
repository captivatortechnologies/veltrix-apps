import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { AZURE_SERVICE_BUS_TRANSPORT_TYPES, ENGINE_PROTOCOLS } from './_shared'

/**
 * Validate the Distributed Engine Configuration singleton: at most one
 * declared item, a supported protocol/transport type, and a warning (not a
 * hard error, since the exact inequality direction is unverified against a
 * live instance) when a message's time-to-live does not exceed its retry
 * interval. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Distributed Engine Configuration item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Distributed Engine Configuration is a singleton — declare it only once per canvas.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const f = item.fields ?? {}

    const protocol = String(f.protocol ?? 'Https')
    if (!(ENGINE_PROTOCOLS as readonly string[]).includes(protocol)) {
      errors.push({ field: `items[${i}].protocol`, message: `Protocol must be one of ${ENGINE_PROTOCOLS.join(', ')}.`, code: 'INVALID_PROTOCOL' })
    }

    const azTransport = String(f.azureServiceBusTransportType ?? 'Amqp')
    if (!(AZURE_SERVICE_BUS_TRANSPORT_TYPES as readonly string[]).includes(azTransport)) {
      errors.push({
        field: `items[${i}].azureServiceBusTransportType`,
        message: `Azure Service Bus transport type must be one of ${AZURE_SERVICE_BUS_TRANSPORT_TYPES.join(', ')}.`,
        code: 'INVALID_AZURE_TRANSPORT',
      })
    }

    const heartbeatTtl = f.heartbeatTimeToLive === undefined || f.heartbeatTimeToLive === '' ? undefined : Number(f.heartbeatTimeToLive)
    const heartbeatRetry = f.heartbeatRetry === undefined || f.heartbeatRetry === '' ? undefined : Number(f.heartbeatRetry)
    if (heartbeatTtl !== undefined && heartbeatRetry !== undefined && heartbeatTtl <= heartbeatRetry) {
      warnings.push({
        field: `items[${i}].heartbeatTimeToLive`,
        message: 'Heartbeat time-to-live should exceed the retry interval; verify against your Secret Server instance.',
        code: 'HEARTBEAT_TIMING_SUSPECT',
      })
    }

    const rpcTtl = f.rpcTimeToLive === undefined || f.rpcTimeToLive === '' ? undefined : Number(f.rpcTimeToLive)
    const rpcRetry = f.rpcRetry === undefined || f.rpcRetry === '' ? undefined : Number(f.rpcRetry)
    if (rpcTtl !== undefined && rpcRetry !== undefined && rpcTtl <= rpcRetry) {
      warnings.push({
        field: `items[${i}].rpcTimeToLive`,
        message: 'Password-change message time-to-live should exceed the retry interval; verify against your Secret Server instance.',
        code: 'RPC_TIMING_SUSPECT',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
