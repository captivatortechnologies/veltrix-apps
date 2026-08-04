import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseSubnetList, isIpOrCidr, buildDesiredState, stateFromGet, sortedJoin, statesEqual } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (subnet parsing, state shaping, comparison).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { include: '10.0.0.0/8, 192.168.1.0/24', exclude: '10.5.5.5', drop: '' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good singleton item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate errors on more than one item (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate rejects a malformed subnet', async () => {
  const res = await validate(ctxOf([{ ...good, include: '999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SUBNET'))
})

test('validate warns when all three lists are empty', async () => {
  const res = await validate(ctxOf([{ include: '', exclude: '', drop: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_REPLACE'))
})

// --- _shared helpers --------------------------------------------------------

test('parseSubnetList splits, trims and de-duplicates', () => {
  assert.deepEqual(parseSubnetList('10.0.0.0/8, 10.0.0.0/8  192.168.1.1'), ['10.0.0.0/8', '192.168.1.1'])
  assert.deepEqual(parseSubnetList(''), [])
})

test('isIpOrCidr accepts valid IPv4 and CIDR, rejects malformed input', () => {
  assert.equal(isIpOrCidr('10.0.0.0/8'), true)
  assert.equal(isIpOrCidr('192.168.1.1'), true)
  assert.equal(isIpOrCidr('999.1.1.1'), false)
  assert.equal(isIpOrCidr('10.0.0.0/99'), false)
})

test('buildDesiredState parses all three lists from canvas fields', () => {
  assert.deepEqual(buildDesiredState(good), {
    include: ['10.0.0.0/8', '192.168.1.0/24'],
    exclude: ['10.5.5.5'],
    drop: [],
  })
})

test('stateFromGet remaps the GET response key names', () => {
  assert.deepEqual(
    stateFromGet({ included_subnets: ['10.0.0.0/8'], excluded_subnets: [], dropped_subnets: ['10.9.9.9'] }),
    { include: ['10.0.0.0/8'], exclude: [], drop: ['10.9.9.9'] },
  )
  assert.deepEqual(stateFromGet(null), { include: [], exclude: [], drop: [] })
})

test('sortedJoin / statesEqual compare order-insensitively', () => {
  assert.equal(sortedJoin(['b', 'a']), sortedJoin(['a', 'b']))
  assert.equal(
    statesEqual({ include: ['a', 'b'], exclude: [], drop: [] }, { include: ['b', 'a'], exclude: [], drop: [] }),
    true,
  )
  assert.equal(
    statesEqual({ include: ['a'], exclude: [], drop: [] }, { include: ['b'], exclude: [], drop: [] }),
    false,
  )
})
