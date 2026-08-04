import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toOneToOneBody, snapshotOneToOne, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `mapping-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validMapping = { interface: 'wan', ipprotocol: 'inet', external: '203.0.113.20', source: '10.0.0.5', destination: 'any', descr: 'DMZ web server' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires an interface', async () => {
  const res = await validate(ctxOf([{ ...validMapping, interface: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERFACE'))
})

test('validate requires a valid external address (no bare interface or "any")', async () => {
  const empty = await validate(ctxOf([{ ...validMapping, external: '' }]))
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_EXTERNAL'))

  const anyExternal = await validate(ctxOf([{ ...validMapping, external: 'any' }]))
  assert.ok(anyExternal.errors.some((e) => e.code === 'INVALID_EXTERNAL'))
})

test('validate accepts an external address that is an IP or an interface :ip modifier', async () => {
  const ip = await validate(ctxOf([{ ...validMapping, external: '203.0.113.20' }]))
  assert.equal(ip.errors.some((e) => e.code === 'INVALID_EXTERNAL'), false)

  const ifIp = await validate(ctxOf([{ ...validMapping, external: 'wan:ip' }]))
  assert.equal(ifIp.errors.some((e) => e.code === 'INVALID_EXTERNAL'), false)
})

test('validate requires source and destination', async () => {
  const res = await validate(ctxOf([{ ...validMapping, source: '', destination: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SOURCE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESTINATION'))
})

test('validate accepts "any" as a destination (filter address, unlike NAT target)', async () => {
  const res = await validate(ctxOf([{ ...validMapping, destination: 'any' }]))
  assert.equal(res.errors.some((e) => e.code === 'INVALID_DESTINATION'), false)
})

test('validate accepts a well-formed 1:1 mapping', async () => {
  const res = await validate(ctxOf([validMapping]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns (does not error) on a missing description', async () => {
  const res = await validate(ctxOf([{ ...validMapping, descr: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_DESCRIPTION'))
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validMapping, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('specFromItem uses the canvas item id as itemId (mapping identity)', () => {
  const spec = specFromItem({ id: 'mapping-abc', name: 'x', fields: validMapping })
  assert.equal(spec.itemId, 'mapping-abc')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validMapping, validMapping]))
  assert.equal(specs.length, 2)
})

test('toOneToOneBody maps null natreflection when unset', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validMapping })
  assert.equal(toOneToOneBody(spec).natreflection, null)
})

test('snapshotOneToOne never includes id', () => {
  const snap = snapshotOneToOne({ id: 6, interface: 'wan', external: '203.0.113.20', source: '10.0.0.5', destination: 'any' }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.interface, 'wan')
})
