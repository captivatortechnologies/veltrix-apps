import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, gatewayKey, toGatewayCreateBody, toGatewayUpdateBody, snapshotGateway, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `gw-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validGw = { name: 'WAN_GW', ipprotocol: 'inet', interface: 'wan', gateway: '203.0.113.1', descr: 'Primary WAN gateway' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', async () => {
  const res = await validate(ctxOf([{ ...validGw, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name over the 31-character limit', async () => {
  const res = await validate(ctxOf([{ ...validGw, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a purely numeric name', async () => {
  const res = await validate(ctxOf([{ ...validGw, name: '12345' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a duplicate name', async () => {
  const res = await validate(ctxOf([validGw, validGw]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate requires an interface', async () => {
  const res = await validate(ctxOf([{ ...validGw, interface: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERFACE'))
})

test('validate accepts "dynamic" as the gateway address', async () => {
  const res = await validate(ctxOf([{ ...validGw, gateway: 'dynamic' }]))
  assert.equal(res.errors.some((e) => e.code.includes('GATEWAY')), false)
})

test('validate rejects a malformed gateway address', async () => {
  const res = await validate(ctxOf([{ ...validGw, gateway: 'not-an-ip' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GATEWAY'))
})

test('validate rejects an IP-family mismatch between ipprotocol and gateway', async () => {
  const res = await validate(ctxOf([{ ...validGw, ipprotocol: 'inet6', gateway: '203.0.113.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'GATEWAY_IP_FAMILY_MISMATCH'))
})

test('validate accepts a matching IPv6 gateway with ipprotocol inet6', async () => {
  const res = await validate(ctxOf([{ ...validGw, ipprotocol: 'inet6', interface: 'wan', gateway: '2001:db8::1' }]))
  assert.equal(res.errors.some((e) => e.code === 'GATEWAY_IP_FAMILY_MISMATCH'), false)
})

test('validate rejects an invalid monitor IP unless monitoring is disabled', async () => {
  const res = await validate(ctxOf([{ ...validGw, monitor: 'not-an-ip' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MONITOR'))

  const disabledRes = await validate(ctxOf([{ ...validGw, monitor: 'not-an-ip', monitor_disable: true }]))
  assert.equal(disabledRes.errors.some((e) => e.code === 'INVALID_MONITOR'), false)
})

test('validate rejects an out-of-range weight', async () => {
  const res = await validate(ctxOf([{ ...validGw, weight: 99 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WEIGHT'))
})

test('validate accepts a well-formed gateway', async () => {
  const res = await validate(ctxOf([validGw]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validGw, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('gatewayKey is case-sensitive (no folding)', () => {
  assert.notEqual(gatewayKey('WAN_GW'), gatewayKey('wan_gw'))
})

test('extractSpecs maps every item, defaulting weight to 1 when out of range', () => {
  const specs = extractSpecs(toItems([validGw, { ...validGw, name: 'other', weight: 'not-a-number' }]))
  assert.equal(specs.length, 2)
  assert.equal(specs[1].weight, 1)
})

test('toGatewayCreateBody includes name; toGatewayUpdateBody omits it', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validGw })
  assert.equal(toGatewayCreateBody(spec).name, 'WAN_GW')
  assert.equal('name' in toGatewayUpdateBody(spec), false)
})

test('toGatewayCreateBody clears monitor when monitoring is disabled', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: { ...validGw, monitor: '10.0.0.1', monitor_disable: true } })
  assert.equal(toGatewayCreateBody(spec).monitor, null)
})

test('snapshotGateway never includes id or name', () => {
  const snap = snapshotGateway({ id: 5, name: 'WAN_GW', ipprotocol: 'inet', interface: 'wan', gateway: '203.0.113.1' }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal('name' in snap, false)
  assert.equal(snap.gateway, '203.0.113.1')
})
