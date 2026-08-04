import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { declaredAddresses, diffAddresses, findAddressGroupByName, listFrom, liveAddresses } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the BeyondInsight REST API via node:https inside
 * beyondtrustApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (list-unwrap, address diffing), which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Corp Offices', addresses: ['10.0.0.1', '10.0.1.0/24'] }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an over-long name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'a'.repeat(257) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects an address with an implausible charset', async () => {
  const res = await validate(ctxOf([{ ...good, addresses: ['not an address'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADDRESS'))
})

test('validate accepts single IPs, CIDR ranges and comma-delimited lists', async () => {
  const res = await validate(ctxOf([{ ...good, addresses: ['10.0.0.1', '10.0.0.0/24', '10.0.0.1,10.0.0.2,10.0.0.3', '10.0.0.1-10.0.0.10'] }]))
  assert.equal(res.valid, true)
})

test('validate warns when a group has no addresses', async () => {
  const res = await validate(ctxOf([{ ...good, addresses: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_ADDRESSES'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, addresses: ['10.0.0.2'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GROUP'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('declaredAddresses trims, drops blanks and de-duplicates case-insensitively, preserving order', () => {
  assert.deepEqual(declaredAddresses([' 10.0.0.1 ', '', '10.0.0.2', '10.0.0.1']), ['10.0.0.1', '10.0.0.2'])
  assert.deepEqual(declaredAddresses(undefined), [])
})

test('liveAddresses extracts IPAddress strings, dropping blanks', () => {
  assert.deepEqual(liveAddresses([{ AddressID: 1, IPAddress: '10.0.0.1' }, { AddressID: 2, IPAddress: '' }]), ['10.0.0.1'])
})

test('diffAddresses finds additions and removals case-insensitively', () => {
  const live = [
    { AddressID: 1, IPAddress: '10.0.0.1' },
    { AddressID: 2, IPAddress: '10.0.0.2' },
  ]
  const { toAdd, toRemove } = diffAddresses(['10.0.0.1', '10.0.0.3'], live)
  assert.deepEqual(toAdd, ['10.0.0.3'])
  assert.deepEqual(toRemove, [{ AddressID: 2, IPAddress: '10.0.0.2' }])
})

test('diffAddresses is a no-op when declared matches live exactly', () => {
  const live = [{ AddressID: 1, IPAddress: '10.0.0.1' }]
  const { toAdd, toRemove } = diffAddresses(['10.0.0.1'], live)
  assert.deepEqual(toAdd, [])
  assert.deepEqual(toRemove, [])
})

test('listFrom unwraps arrays and paginated containers', () => {
  assert.equal(listFrom<{ a: number }>([{ a: 1 }]).length, 1)
  assert.equal(listFrom<{ a: number }>({ Data: [{ a: 1 }, { a: 2 }] }).length, 2)
  assert.equal(listFrom<unknown>(null).length, 0)
})

test('findAddressGroupByName matches case-insensitively', () => {
  const live = [{ AddressGroupID: 7, Name: 'Corp Offices' }]
  assert.equal(findAddressGroupByName(live, 'CORP OFFICES')?.AddressGroupID, 7)
  assert.equal(findAddressGroupByName(live, 'nope'), null)
})
