import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { assignmentsFromList, devicesForUuid, parseDeviceList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (envelope unwrapping, device-set derivation).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ruleset_uuid ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { ruleset_uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', device_serials: 'SN-1, SN-2' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good assignment item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing ruleset_uuid', async () => {
  const res = await validate(ctxOf([{ ...good, ruleset_uuid: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_UUID'))
})

test('validate rejects a malformed ruleset_uuid', async () => {
  const res = await validate(ctxOf([{ ...good, ruleset_uuid: '!!!not-a-uuid!!!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_UUID'))
})

test('validate warns on a duplicate ruleset_uuid', async () => {
  const res = await validate(ctxOf([good, { ...good, device_serials: 'SN-3' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_UUID'))
})

test('validate warns on an empty device list', async () => {
  const res = await validate(ctxOf([{ ...good, device_serials: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_DEVICE_LIST'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('parseDeviceList splits, trims and de-duplicates', () => {
  assert.deepEqual(parseDeviceList('SN-1, SN-2  SN-1'), ['SN-1', 'SN-2'])
  assert.deepEqual(parseDeviceList(''), [])
})

test('assignmentsFromList unwraps assignments, results and bare arrays', () => {
  assert.deepEqual(assignmentsFromList({ assignments: [{ uuid: 'a', device_serial: 'SN-1' }] }), [{ uuid: 'a', device_serial: 'SN-1' }])
  assert.deepEqual(assignmentsFromList({ results: [{ uuid: 'b' }] }), [{ uuid: 'b' }])
  assert.deepEqual(assignmentsFromList([{ uuid: 'c' }]), [{ uuid: 'c' }])
  assert.deepEqual(assignmentsFromList(null), [])
})

test('devicesForUuid filters by uuid and collects device serials', () => {
  const list = [
    { uuid: 'a', device_serial: 'SN-1' },
    { uuid: 'a', device_serial: 'SN-2' },
    { uuid: 'b', device_serial: 'SN-3' },
  ]
  assert.deepEqual([...devicesForUuid(list, 'a')].sort(), ['SN-1', 'SN-2'])
  assert.deepEqual([...devicesForUuid(list, 'b')].sort(), ['SN-3'])
  assert.deepEqual([...devicesForUuid(list, 'c')], [])
})
