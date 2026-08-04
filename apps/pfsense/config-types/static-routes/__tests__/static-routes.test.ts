import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toStaticRouteBody, snapshotStaticRoute, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `route-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validRoute = { network: '10.10.0.0/24', gateway: 'WAN_GW', descr: 'Branch office' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a network', async () => {
  const res = await validate(ctxOf([{ ...validRoute, network: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NETWORK'))
})

test('validate rejects a malformed network', async () => {
  const res = await validate(ctxOf([{ ...validRoute, network: 'not a cidr!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NETWORK'))
})

test('validate accepts an alias-shaped network (existing alias)', async () => {
  const res = await validate(ctxOf([{ ...validRoute, network: 'BRANCH_SUBNET' }]))
  assert.equal(res.errors.some((e) => e.code === 'INVALID_NETWORK'), false)
})

test('validate requires a gateway', async () => {
  const res = await validate(ctxOf([{ ...validRoute, gateway: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GATEWAY'))
})

test('validate rejects a malformed gateway name', async () => {
  const res = await validate(ctxOf([{ ...validRoute, gateway: 'not a name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GATEWAY'))
})

test('validate accepts a well-formed static route', async () => {
  const res = await validate(ctxOf([validRoute]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validRoute, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('specFromItem uses the canvas item id as itemId (route identity)', () => {
  const spec = specFromItem({ id: 'route-abc', name: 'x', fields: validRoute })
  assert.equal(spec.itemId, 'route-abc')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validRoute, validRoute]))
  assert.equal(specs.length, 2)
})

test('toStaticRouteBody carries every declared field, no id', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validRoute })
  const body = toStaticRouteBody(spec) as Record<string, unknown>
  assert.equal('id' in body, false)
  assert.equal(body.network, '10.10.0.0/24')
  assert.equal(body.gateway, 'WAN_GW')
})

test('snapshotStaticRoute never includes id', () => {
  const snap = snapshotStaticRoute({ id: 3, network: '10.10.0.0/24', gateway: 'WAN_GW', descr: 'x', disabled: false }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.network, '10.10.0.0/24')
})
