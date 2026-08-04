import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { buildZoneBody, buildZoneBodyFromPrior, normalizeZoneType, parseAdvanced, parseStringList, readZoneFields, zonePath } from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Edge DNS API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid
 * signer itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.zone ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodPrimary = { zone: 'example.com', type: 'PRIMARY', contractId: '1-ABC123', comment: 'prod zone' }
const goodSecondary = { zone: 'secondary.example.com', type: 'SECONDARY', contractId: '1-ABC123', masters: '203.0.113.1\n203.0.113.2' }
const goodAlias = { zone: 'alias.example.com', type: 'ALIAS', contractId: '1-ABC123', target: 'example.com' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good PRIMARY zone', async () => {
  const res = await validate(ctxOf([goodPrimary]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a good SECONDARY zone with masters', async () => {
  const res = await validate(ctxOf([goodSecondary]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a good ALIAS zone with a target', async () => {
  const res = await validate(ctxOf([goodAlias]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing zone name', async () => {
  const res = await validate(ctxOf([{ ...goodPrimary, zone: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ZONE'))
})

test('validate rejects a malformed zone name', async () => {
  const res = await validate(ctxOf([{ ...goodPrimary, zone: 'not a domain' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ZONE'))
})

test('validate rejects a missing contract id', async () => {
  const res = await validate(ctxOf([{ ...goodPrimary, contractId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTRACT'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...goodPrimary, type: 'TERTIARY' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate requires masters for SECONDARY', async () => {
  const res = await validate(ctxOf([{ ...goodSecondary, masters: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_MASTERS'))
})

test('validate rejects an invalid master IP', async () => {
  const res = await validate(ctxOf([{ ...goodSecondary, masters: 'not-an-ip' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MASTER'))
})

test('validate requires a target for ALIAS', async () => {
  const res = await validate(ctxOf([{ ...goodAlias, target: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TARGET'))
})

test('validate rejects an unknown DNSSEC algorithm', async () => {
  const res = await validate(ctxOf([{ ...goodPrimary, signAndServe: true, signAndServeAlgorithm: 'MD5' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ALGORITHM'))
})

test('validate rejects malformed advanced JSON', async () => {
  const res = await validate(ctxOf([{ ...goodPrimary, advanced: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADVANCED_JSON'))
})

test('validate warns on a duplicate zone (case-insensitive)', async () => {
  const res = await validate(ctxOf([goodPrimary, { ...goodPrimary, zone: 'EXAMPLE.COM' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ZONE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeZoneType coerces to a known type with PRIMARY as the default', () => {
  assert.equal(normalizeZoneType('secondary'), 'SECONDARY')
  assert.equal(normalizeZoneType('ALIAS'), 'ALIAS')
  assert.equal(normalizeZoneType('nonsense'), 'PRIMARY')
})

test('parseStringList splits, trims and de-dupes', () => {
  assert.deepEqual(parseStringList('1.1.1.1\n2.2.2.2, 1.1.1.1\n'), ['1.1.1.1', '2.2.2.2'])
})

test('parseAdvanced accepts blank input and valid JSON objects', () => {
  assert.deepEqual(parseAdvanced(''), {})
  assert.deepEqual(parseAdvanced('{"tsigKey":{"name":"k"}}'), { tsigKey: { name: 'k' } })
})

test('parseAdvanced throws on malformed JSON and non-object values', () => {
  assert.throws(() => parseAdvanced('{bad'))
  assert.throws(() => parseAdvanced('[1,2,3]'))
})

test('readZoneFields normalizes an item into a create/update field set', () => {
  const f = readZoneFields(goodSecondary)
  assert.equal(f.zone, 'secondary.example.com')
  assert.equal(f.type, 'SECONDARY')
  assert.deepEqual(f.masters, ['203.0.113.1', '203.0.113.2'])
})

test('buildZoneBody includes masters only for SECONDARY and target only for ALIAS', () => {
  const secondaryBody = buildZoneBody(readZoneFields(goodSecondary))
  assert.deepEqual(secondaryBody.masters, ['203.0.113.1', '203.0.113.2'])
  assert.equal(secondaryBody.target, undefined)

  const aliasBody = buildZoneBody(readZoneFields(goodAlias))
  assert.equal(aliasBody.target, 'example.com')
  assert.equal(aliasBody.masters, undefined)
})

test('buildZoneBody merges advanced JSON but typed fields win on key collision', () => {
  const body = buildZoneBody(readZoneFields({ ...goodPrimary, advanced: '{"comment":"from-advanced","tsigKey":{"name":"k"}}' }))
  assert.equal(body.comment, 'prod zone') // typed field wins
  assert.deepEqual(body.tsigKey, { name: 'k' })
})

test('buildZoneBodyFromPrior strips computed/read-only fields', () => {
  const prior = {
    zone: 'example.com',
    type: 'PRIMARY',
    comment: 'x',
    aliasCount: 3,
    activationState: 'ACTIVE',
    lastModifiedDate: '2026-01-01',
    versionId: 'v1',
  }
  const body = buildZoneBodyFromPrior(prior)
  assert.deepEqual(body, { zone: 'example.com', type: 'PRIMARY', comment: 'x' })
})

test('zonePath URL-encodes the zone name', () => {
  assert.equal(zonePath('example.com'), '/config-dns/v2/zones/example.com')
})
