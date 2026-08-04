import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractDistributedEngineConfigSpec,
  buildDistributedEngineConfigPatchBody,
  buildDistributedEngineConfigRestoreBody,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers in _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { enabled: true, protocol: 'Https', azureServiceBusTransportType: 'Amqp' }

// --- validate ---------------------------------------------------------------

test('validate accepts the singleton with defaults', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects more than one declared item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate rejects an unsupported protocol', async () => {
  const res = await validate(ctxOf([{ ...good, protocol: 'Ftp' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate rejects an unsupported Azure transport type', async () => {
  const res = await validate(ctxOf([{ ...good, azureServiceBusTransportType: 'Sbmp' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AZURE_TRANSPORT'))
})

test('validate warns when heartbeat time-to-live does not exceed its retry interval', async () => {
  const res = await validate(ctxOf([{ ...good, heartbeatTimeToLive: 5, heartbeatRetry: 10 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'HEARTBEAT_TIMING_SUSPECT'))
})

test('validate warns when RPC time-to-live does not exceed its retry interval', async () => {
  const res = await validate(ctxOf([{ ...good, rpcTimeToLive: 5, rpcRetry: 10 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'RPC_TIMING_SUSPECT'))
})

test('validate does not warn when heartbeat timing looks sane', async () => {
  const res = await validate(ctxOf([{ ...good, heartbeatTimeToLive: 10, heartbeatRetry: 5 }]))
  assert.equal(res.warnings.length, 0)
})

// --- _shared helpers --------------------------------------------------------

test('extractDistributedEngineConfigSpec applies safe defaults for unset/invalid enums', () => {
  const spec = extractDistributedEngineConfigSpec({ protocol: 'Bogus', azureServiceBusTransportType: 'Bogus' })
  assert.equal(spec.protocol, 'Https')
  assert.equal(spec.azureServiceBusTransportType, 'Amqp')
  assert.equal(spec.callbackPort, null)
  assert.equal(spec.enabled, false)
})

test('buildDistributedEngineConfigPatchBody always sends the core fields, wrapped in { dirty, value }', () => {
  const spec = extractDistributedEngineConfigSpec(good)
  const body = buildDistributedEngineConfigPatchBody(spec) as { data: Record<string, { dirty: boolean; value: unknown }> }
  assert.equal(body.data.enableDistributedEngines.dirty, true)
  assert.equal(body.data.enableDistributedEngines.value, true)
  assert.equal(body.data.protocol.value, 'Https')
  assert.equal(body.data.azureServiceBusTransportType.value, 'Amqp')
})

test('buildDistributedEngineConfigPatchBody omits optional fields that were never set', () => {
  const spec = extractDistributedEngineConfigSpec(good)
  const body = buildDistributedEngineConfigPatchBody(spec) as { data: Record<string, unknown> }
  assert.equal('callbackPort' in body.data, false)
  assert.equal('callbackUrl' in body.data, false)
  assert.equal('secretHeartbeatMessageMinutesToLive' in body.data, false)
})

test('buildDistributedEngineConfigPatchBody includes optional fields once set', () => {
  const spec = extractDistributedEngineConfigSpec({ ...good, callbackPort: 8043, heartbeatTimeToLive: 20, heartbeatRetry: 5 })
  const body = buildDistributedEngineConfigPatchBody(spec) as { data: Record<string, { dirty: boolean; value: unknown }> }
  assert.equal(body.data.callbackPort.value, 8043)
  assert.equal(body.data.secretHeartbeatMessageMinutesToLive.value, 20)
  assert.equal(body.data.secretHeartbeatMessageRetryMinutes.value, 5)
})

test('buildDistributedEngineConfigRestoreBody rebuilds the patch body from a live snapshot', () => {
  const body = buildDistributedEngineConfigRestoreBody({
    enableDistributedEngines: false,
    protocol: 'Http',
    azureServiceBusTransportType: 'AmqpWebSockets',
    callbackPort: 9000,
  }) as { data: Record<string, { dirty: boolean; value: unknown }> }
  assert.equal(body.data.enableDistributedEngines.value, false)
  assert.equal(body.data.protocol.value, 'Http')
  assert.equal(body.data.azureServiceBusTransportType.value, 'AmqpWebSockets')
  assert.equal(body.data.callbackPort.value, 9000)
})
