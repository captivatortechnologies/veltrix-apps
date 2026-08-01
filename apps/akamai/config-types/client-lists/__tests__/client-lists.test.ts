import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import {
  parseItemValues,
  parseTags,
  parseGroupId,
  normalizeClientListType,
  clientListsFromResponse,
  findClientList,
  valuesFromList,
  sameStrings,
  diffValues,
  toItemPayload,
  readClientListFields,
} from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Client Lists API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (network-free). The EdgeGrid signer itself is
 * covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodIp = { name: 'Corp blocklist', type: 'IP', contractId: '1-ABC123', groupId: 12345, notes: 'blocked ranges', tags: ['prod'], items: '203.0.113.0/24\n198.51.100.7' }
const goodGeo = { name: 'Blocked countries', type: 'GEO', contractId: '1-ABC123', groupId: 12345, notes: '', tags: [], items: 'US\ngb' }
const goodAsn = { name: 'Blocked ASNs', type: 'ASN', contractId: '1-ABC123', groupId: 12345, items: 'AS64512\n64513' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good IP client list', async () => {
  const res = await validate(ctxOf([goodIp]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a good GEO client list (case-insensitive codes)', async () => {
  const res = await validate(ctxOf([goodGeo]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a good ASN client list', async () => {
  const res = await validate(ctxOf([goodAsn]))
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

test('validate requires a contract id and a numeric group id', async () => {
  const res = await validate(ctxOf([{ ...goodIp, contractId: '', groupId: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTRACT'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP'))
})

test('validate rejects more than five tags', async () => {
  const res = await validate(ctxOf([{ ...goodIp, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'TOO_MANY_TAGS'))
})

test('validate rejects a malformed IP entry', async () => {
  const res = await validate(ctxOf([{ ...goodIp, items: '999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP'))
})

test('validate rejects a bad ASN entry', async () => {
  const res = await validate(ctxOf([{ ...goodAsn, items: 'not-an-asn' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASN'))
})

test('validate accepts opaque entries for richer types (e.g. FILE_HASH)', async () => {
  const res = await validate(ctxOf([{ ...goodIp, type: 'FILE_HASH', items: 'd41d8cd98f00b204e9800998ecf8427e\nanything-goes' }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate warns on an empty entry list', async () => {
  const res = await validate(ctxOf([{ ...goodIp, items: '' }]))
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

test('parseItemValues splits, trims, de-dupes and upper-cases GEO codes', () => {
  assert.deepEqual(parseItemValues('1.1.1.1\n2.2.2.2, 1.1.1.1\n', 'IP'), ['1.1.1.1', '2.2.2.2'])
  assert.deepEqual(parseItemValues('us\nGB\nus', 'GEO'), ['US', 'GB'])
  // Non-GEO types keep exact casing (hashes/fingerprints are case-sensitive).
  assert.deepEqual(parseItemValues('AbC\nabc', 'FILE_HASH'), ['AbC', 'abc'])
})

test('parseTags trims and de-dupes', () => {
  assert.deepEqual(parseTags(['prod', ' prod ', 'edge']), ['prod', 'edge'])
  assert.deepEqual(parseTags('a, b\nc'), ['a', 'b', 'c'])
})

test('parseGroupId coerces to a positive integer or null', () => {
  assert.equal(parseGroupId(12345), 12345)
  assert.equal(parseGroupId('678'), 678)
  assert.equal(parseGroupId(0), null)
  assert.equal(parseGroupId('nope'), null)
})

test('normalizeClientListType coerces unknowns to IP', () => {
  assert.equal(normalizeClientListType('asn'), 'ASN')
  assert.equal(normalizeClientListType('TLS_FINGERPRINT'), 'TLS_FINGERPRINT')
  assert.equal(normalizeClientListType('nonsense'), 'IP')
})

test('clientListsFromResponse unwraps content / lists / bare array', () => {
  assert.deepEqual(clientListsFromResponse({ content: [{ name: 'a' }] }), [{ name: 'a' }])
  assert.deepEqual(clientListsFromResponse({ lists: [{ name: 'b' }] }), [{ name: 'b' }])
  assert.deepEqual(clientListsFromResponse([{ name: 'c' }]), [{ name: 'c' }])
  assert.deepEqual(clientListsFromResponse(null), [])
})

test('findClientList matches by name case-insensitively', () => {
  const lists = [{ name: 'Alpha', listId: '1' }, { name: 'Beta', listId: '2' }]
  assert.equal(findClientList(lists, 'beta')?.listId, '2')
  assert.equal(findClientList(lists, 'missing'), null)
})

test('valuesFromList extracts non-empty entry values', () => {
  assert.deepEqual(valuesFromList({ items: [{ value: '1.1.1.1' }, { value: '' }, { value: '2.2.2.2' }] }), ['1.1.1.1', '2.2.2.2'])
  assert.deepEqual(valuesFromList({}), [])
})

test('diffValues computes append/remove for a full replace', () => {
  assert.deepEqual(diffValues(['a', 'b', 'c'], ['b', 'c', 'd']), { append: ['a'], remove: ['d'] })
  assert.deepEqual(diffValues(['a'], ['a']), { append: [], remove: [] })
})

test('sameStrings is order-insensitive', () => {
  assert.equal(sameStrings(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameStrings(['a'], ['a', 'b']), false)
})

test('toItemPayload wraps values as { value } objects', () => {
  assert.deepEqual(toItemPayload(['x', 'y']), [{ value: 'x' }, { value: 'y' }])
})

test('readClientListFields normalizes an item into a deploy-ready shape', () => {
  assert.deepEqual(readClientListFields(goodGeo), {
    name: 'Blocked countries',
    type: 'GEO',
    notes: '',
    tags: [],
    contractId: '1-ABC123',
    groupId: 12345,
    values: ['US', 'GB'],
  })
})
