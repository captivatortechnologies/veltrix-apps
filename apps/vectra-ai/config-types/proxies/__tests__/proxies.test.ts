import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildProxyBody,
  proxiesFromList,
  findProxy,
  addressOf,
  considerProxyOf,
  idOfProxy,
  normalizeBool,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (body building, envelope unwrapping, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.address ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { address: '10.10.0.5', considerProxy: true }

// --- validate ---------------------------------------------------------------

test('validate accepts a good proxy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a CIDR proxy address', async () => {
  const res = await validate(ctxOf([{ ...good, address: '10.10.0.0/24' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing address', async () => {
  const res = await validate(ctxOf([{ ...good, address: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ADDRESS'))
})

test('validate rejects a malformed address', async () => {
  const res = await validate(ctxOf([{ ...good, address: '999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADDRESS'))
})

test('validate warns on a duplicate address', async () => {
  const res = await validate(ctxOf([good, { ...good, considerProxy: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ADDRESS'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('buildProxyBody wraps address + considerProxy under proxy', () => {
  assert.deepEqual(buildProxyBody(good), { proxy: { address: '10.10.0.5', considerProxy: true } })
  assert.deepEqual(buildProxyBody({ address: '10.0.0.1', considerProxy: 'false' }), {
    proxy: { address: '10.0.0.1', considerProxy: false },
  })
})

test('normalizeBool coerces common truthy strings', () => {
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool(1), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(undefined), false)
})

test('proxiesFromList unwraps proxies, results and bare arrays', () => {
  assert.deepEqual(proxiesFromList({ proxies: [{ id: 1 }] }), [{ id: 1 }])
  assert.deepEqual(proxiesFromList({ count: 1, results: [{ id: 2 }] }), [{ id: 2 }])
  assert.deepEqual(proxiesFromList([{ id: 3 }]), [{ id: 3 }])
  assert.deepEqual(proxiesFromList(null), [])
})

test('addressOf / considerProxyOf read flattened or nested shapes', () => {
  assert.equal(addressOf({ address: '10.0.0.1', considerProxy: true }), '10.0.0.1')
  assert.equal(addressOf({ proxy: { address: '10.0.0.2', considerProxy: false } }), '10.0.0.2')
  assert.equal(considerProxyOf({ proxy: { considerProxy: true } }), true)
  assert.equal(considerProxyOf({ considerProxy: false }), false)
})

test('idOfProxy reads bare or wrapped ids', () => {
  assert.equal(idOfProxy({ id: 7 }), 7)
  assert.equal(idOfProxy({ proxy: { id: 8 } }), 8)
  assert.equal(idOfProxy(null), null)
})

test('findProxy matches by address across shapes', () => {
  const proxies = [{ id: 1, address: '10.0.0.1' }, { id: 2, proxy: { address: '10.0.0.2' } }]
  assert.equal(findProxy(proxies, '10.0.0.2')?.id, 2)
  assert.equal(findProxy(proxies, '10.9.9.9'), null)
})
