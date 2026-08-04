import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toIseEndpointBody, isValidMac, normalizeMac } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.mac ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { mac: 'AA:BB:CC:DD:EE:FF' }

test('validate rejects a missing MAC', async () => {
  const res = await validate(ctxOf([{ mac: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_MAC'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a malformed MAC', async () => {
  const res = await validate(ctxOf([{ mac: 'not-a-mac' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MAC'))
})

test('validate warns on a duplicate MAC across separator styles', async () => {
  const res = await validate(ctxOf([good, { mac: 'aa-bb-cc-dd-ee-ff', description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_MAC'))
})

test('validate accepts a well-formed endpoint', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('isValidMac accepts colon, dash and bare separator styles', () => {
  assert.equal(isValidMac('AA:BB:CC:DD:EE:FF'), true)
  assert.equal(isValidMac('aa-bb-cc-dd-ee-ff'), true)
  assert.equal(isValidMac('aabbccddeeff'), true)
  assert.equal(isValidMac('not-a-mac'), false)
  assert.equal(isValidMac('AA:BB:CC:DD:EE'), false)
})

test('normalizeMac canonicalizes to uppercase colon-separated form', () => {
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(normalizeMac('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF')
})

test('specFromItem normalizes a valid MAC and leaves an invalid one untouched for validate to reject', () => {
  assert.equal(specFromItem({ id: 'i0', name: 'x', fields: { mac: 'aa-bb-cc-dd-ee-ff' } }).mac, 'AA:BB:CC:DD:EE:FF')
  assert.equal(specFromItem({ id: 'i0', name: 'x', fields: { mac: 'garbage' } }).mac, 'garbage')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].mac, 'AA:BB:CC:DD:EE:FF')
})

test('toIseEndpointBody defaults name to the MAC and omits group fields when unresolved', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toIseEndpointBody(spec, null)
  assert.equal(body.name, 'AA:BB:CC:DD:EE:FF')
  assert.equal(body.groupId, undefined)
  assert.equal(body.staticGroupAssignment, undefined)
})

test('toIseEndpointBody includes the resolved group id as a static assignment', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { ...good, group_name: 'Contractors' } })
  const body = toIseEndpointBody(spec, 'group-id-123')
  assert.equal(body.groupId, 'group-id-123')
  assert.equal(body.staticGroupAssignment, 'true')
})
