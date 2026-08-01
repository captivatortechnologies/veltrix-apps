import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { parseElements, normalizeType, findList, listsFromResponse, sameElements, readListFields } from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Network Lists API via
 * fetch inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid signer
 * itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodIp = { name: 'Corp blocklist', type: 'IP', description: 'blocked ranges', list: '203.0.113.0/24\n198.51.100.7' }
const goodGeo = { name: 'Blocked countries', type: 'GEO', description: '', list: 'US\ngb' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good IP list', async () => {
  const res = await validate(ctxOf([goodIp]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a good GEO list (case-insensitive codes)', async () => {
  const res = await validate(ctxOf([goodGeo]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodIp, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...goodIp, type: 'DNS' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a malformed IP element', async () => {
  const res = await validate(ctxOf([{ ...goodIp, list: '999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP'))
})

test('validate rejects a bad GEO code', async () => {
  const res = await validate(ctxOf([{ ...goodGeo, list: 'USA' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GEO'))
})

test('validate warns on an empty element list', async () => {
  const res = await validate(ctxOf([{ ...goodIp, list: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_LIST'))
})

test('validate warns on a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([goodIp, { ...goodIp, name: 'corp blocklist' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('parseElements splits, trims, de-dupes and upper-cases GEO codes', () => {
  assert.deepEqual(parseElements('1.1.1.1\n2.2.2.2, 1.1.1.1\n', 'IP'), ['1.1.1.1', '2.2.2.2'])
  assert.deepEqual(parseElements('us\nGB\nus', 'GEO'), ['US', 'GB'])
  assert.deepEqual(parseElements(['10.0.0.0/8', ' 10.0.0.0/8 '], 'IP'), ['10.0.0.0/8'])
})

test('normalizeType coerces to IP/GEO with IP as the default', () => {
  assert.equal(normalizeType('geo'), 'GEO')
  assert.equal(normalizeType('IP'), 'IP')
  assert.equal(normalizeType('nonsense'), 'IP')
})

test('listsFromResponse unwraps the { networkLists: [...] } envelope', () => {
  assert.deepEqual(listsFromResponse({ networkLists: [{ name: 'a' }] }), [{ name: 'a' }])
  assert.deepEqual(listsFromResponse([{ name: 'b' }]), [{ name: 'b' }])
  assert.deepEqual(listsFromResponse(null), [])
})

test('findList matches by name case-insensitively', () => {
  const lists = [{ name: 'Alpha', uniqueId: '1' }, { name: 'Beta', uniqueId: '2' }]
  assert.equal(findList(lists, 'beta')?.uniqueId, '2')
  assert.equal(findList(lists, 'missing'), null)
})

test('sameElements is order-insensitive', () => {
  assert.equal(sameElements(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameElements(['a'], ['a', 'b']), false)
})

test('readListFields normalizes an item into a create/update body shape', () => {
  assert.deepEqual(readListFields(goodGeo), {
    name: 'Blocked countries',
    type: 'GEO',
    description: '',
    elements: ['US', 'GB'],
  })
})
