import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseEntities,
  buildEntityRef,
  findList,
  listsFromResponse,
  entitiesFromResponse,
  entitySignatures,
  normalize,
  LIST_TYPES,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Recorded Future List API via
 * fetch, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (entity parsing, identity matching, request-body building) —
 * all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Russian Hackers', listType: 'ip', entities: '8.8.8.8\n1.1.1.1', comment: 'nation-state IPs' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed Watch List', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown list type', async () => {
  const res = await validate(ctxOf([{ ...good, listType: 'url' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate accepts every documented list type', async () => {
  for (const listType of LIST_TYPES) {
    const res = await validate(ctxOf([{ ...good, listType, entities: 'entity:xyz' }]))
    assert.equal(res.valid, true, `expected ${listType} to be valid`)
  }
})

test('validate warns on a list with no entities', async () => {
  const res = await validate(ctxOf([{ ...good, entities: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_ENTITIES'))
})

test('validate warns on a duplicate list name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseEntities ------------------------------------------------------------

test('parseEntities splits on newlines and commas and de-duplicates', () => {
  assert.deepEqual(parseEntities('8.8.8.8\n1.1.1.1, 8.8.8.8\n\n  2.2.2.2  '), ['8.8.8.8', '1.1.1.1', '2.2.2.2'])
})

test('parseEntities returns an empty array for blank input', () => {
  assert.deepEqual(parseEntities(''), [])
  assert.deepEqual(parseEntities(null), [])
})

// --- buildEntityRef -----------------------------------------------------------

test('buildEntityRef uses type/name for auto-resolvable list types', () => {
  assert.deepEqual(buildEntityRef('ip', '8.8.8.8'), { type: 'IpAddress', name: '8.8.8.8' })
  assert.deepEqual(buildEntityRef('domain', 'evil.example.com'), { type: 'InternetDomainName', name: 'evil.example.com' })
  assert.deepEqual(buildEntityRef('hash', 'abc123'), { type: 'Hash', name: 'abc123' })
  assert.deepEqual(buildEntityRef('vulnerability', 'CVE-2024-1234'), { type: 'CyberVulnerability', name: 'CVE-2024-1234' })
})

test('buildEntityRef uses an RF entity id for non-auto-resolvable list types', () => {
  assert.deepEqual(buildEntityRef('entity', 'ODuk3q'), { id: 'ODuk3q' })
  assert.deepEqual(buildEntityRef('attacker', 'attacker:XYZ'), { id: 'attacker:XYZ' })
})

// --- findList -----------------------------------------------------------------

test('findList matches by name case-insensitively, preferring the same type', () => {
  const lists = [
    { id: 'report:a', name: 'watchlist', type: 'domain' },
    { id: 'report:b', name: 'WatchList', type: 'ip' },
  ]
  assert.equal(findList(lists, 'watchlist', 'ip')?.id, 'report:b')
  assert.equal(findList(lists, 'watchlist', 'source')?.id, 'report:a') // falls back to any name match
  assert.equal(findList(lists, 'nope', 'ip'), null)
})

// --- response unwrapping + signatures ----------------------------------------

test('listsFromResponse accepts a bare array and a { data } wrapper', () => {
  assert.equal(listsFromResponse([{ id: 'report:a' }]).length, 1)
  assert.equal(listsFromResponse({ data: [{ id: 'report:b' }, { id: 'report:c' }] }).length, 2)
  assert.equal(listsFromResponse(null).length, 0)
})

test('entitiesFromResponse accepts a bare array and an { entities } wrapper', () => {
  assert.equal(entitiesFromResponse([{ id: 'ip:8.8.8.8' }]).length, 1)
  assert.equal(entitiesFromResponse({ entities: [{ name: 'a' }, { name: 'b' }] }).length, 2)
  assert.equal(entitiesFromResponse(null).length, 0)
})

test('entitySignatures indexes both id and name, lowercased', () => {
  const sig = entitySignatures([{ id: 'ip:8.8.8.8', name: 'Google DNS' }])
  assert.ok(sig.has('ip:8.8.8.8'))
  assert.ok(sig.has('google dns'))
  assert.ok(sig.has(normalize('GOOGLE DNS')))
})
