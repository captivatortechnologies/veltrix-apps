import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildStreamCollectionInput,
  buildStreamCollectionPatch,
  findStreamCollection,
  normalizeBool,
  streamCollectionsFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'All Indicators', description: 'Every indicator update', stream_live: true, stream_public: false }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate rejects non-JSON filters and origin_filters', async () => {
  const badFilters = await validate(ctxOf([{ ...good, filters: '{not json' }]))
  assert.equal(badFilters.valid, false)
  assert.ok(badFilters.errors.some((e) => e.code === 'INVALID_FILTERS_JSON'))

  const badOrigin = await validate(ctxOf([{ ...good, origin_filters: '[not json' }]))
  assert.equal(badOrigin.valid, false)
  assert.ok(badOrigin.errors.some((e) => e.code === 'INVALID_ORIGIN_FILTERS_JSON'))
})

test('validate accepts a good collection and valid JSON filters', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const withFilters = await validate(
    ctxOf([{ ...good, filters: '{"mode":"and","filters":[],"filterGroups":[]}', origin_filters: '{"mode":"and"}' }]),
  )
  assert.equal(withFilters.valid, true)
  assert.equal(withFilters.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeBool coerces checkbox-ish values', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(''), undefined)
})

test('buildStreamCollectionInput keeps name + set fields and omits blanks', () => {
  const input = buildStreamCollectionInput({ name: 'All Indicators', description: '', stream_live: true })
  assert.deepEqual(input, { name: 'All Indicators', stream_live: true })

  const full = buildStreamCollectionInput(good)
  assert.equal(full.description, 'Every indicator update')
  assert.equal(full.stream_live, true)
  assert.equal(full.stream_public, false)
})

test('buildStreamCollectionPatch sends native JS values and never patches the identity', () => {
  const patch = buildStreamCollectionPatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const live = patch.find((p) => p.key === 'stream_live')
  assert.deepEqual(live?.value, [true])
  const pub = patch.find((p) => p.key === 'stream_public')
  assert.deepEqual(pub?.value, [false])
})

test('streamCollectionsFromList unwraps the edges/node connection', () => {
  const list = streamCollectionsFromList({
    streamCollections: { edges: [{ node: { id: '1', name: 'All Indicators' } }, { node: { id: '2', name: 'All Reports' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findStreamCollection(list, 'all indicators')?.id, '1')
})
