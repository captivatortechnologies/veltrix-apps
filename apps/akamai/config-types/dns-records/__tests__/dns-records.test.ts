import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { buildRecordBody, normalizeRecordType, parseRdata, readRecordFields, recordPath, sameRdata } from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Edge DNS API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid
 * signer itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodA = { zone: 'example.com', name: 'www.example.com.', recordType: 'A', ttl: 300, rdata: '203.0.113.10\n203.0.113.11' }
const goodMx = { zone: 'example.com', name: 'example.com.', recordType: 'MX', ttl: 3600, rdata: '10 mail.example.com.' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good A record', async () => {
  const res = await validate(ctxOf([goodA]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a good MX record', async () => {
  const res = await validate(ctxOf([goodMx]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing zone', async () => {
  const res = await validate(ctxOf([{ ...goodA, zone: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ZONE'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodA, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unsupported record type', async () => {
  const res = await validate(ctxOf([{ ...goodA, recordType: 'AKAMAITLC' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a negative TTL', async () => {
  const res = await validate(ctxOf([{ ...goodA, ttl: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TTL'))
})

test('validate rejects empty rdata', async () => {
  const res = await validate(ctxOf([{ ...goodA, rdata: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RDATA'))
})

test('validate warns on a duplicate (zone, name, type) triple', async () => {
  const res = await validate(ctxOf([goodA, { ...goodA }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_RECORD'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeRecordType upper-cases', () => {
  assert.equal(normalizeRecordType('a'), 'A')
  assert.equal(normalizeRecordType(' cname '), 'CNAME')
})

test('parseRdata splits on newlines, trims, and preserves order + duplicates', () => {
  assert.deepEqual(parseRdata('1.1.1.1\n1.1.1.1\n \n2.2.2.2'), ['1.1.1.1', '1.1.1.1', '2.2.2.2'])
  assert.deepEqual(parseRdata(['10.0.0.1', ' 10.0.0.2 ']), ['10.0.0.1', '10.0.0.2'])
})

test('readRecordFields normalizes an item into a create/update field set', () => {
  const f = readRecordFields(goodMx)
  assert.equal(f.zone, 'example.com')
  assert.equal(f.recordType, 'MX')
  assert.equal(f.ttl, 3600)
  assert.deepEqual(f.rdata, ['10 mail.example.com.'])
})

test('readRecordFields defaults an invalid TTL to 300', () => {
  const f = readRecordFields({ ...goodA, ttl: -5 })
  assert.equal(f.ttl, 300)
})

test('buildRecordBody shapes the create/update body', () => {
  const body = buildRecordBody(readRecordFields(goodA))
  assert.deepEqual(body, { name: 'www.example.com.', type: 'A', ttl: 300, rdata: ['203.0.113.10', '203.0.113.11'] })
})

test('sameRdata is order-insensitive', () => {
  assert.equal(sameRdata(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameRdata(['a'], ['a', 'b']), false)
})

test('recordPath URL-encodes zone, name and type', () => {
  assert.equal(recordPath('example.com', 'www.example.com.', 'A'), '/config-dns/v2/zones/example.com/names/www.example.com./types/A')
})
