import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildTaxiiCollectionInput,
  buildTaxiiCollectionPatch,
  findTaxiiCollection,
  normalizeBool,
  taxiiCollectionsFromList,
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

const good = {
  name: 'All Malware',
  description: 'Every malware object',
  taxii_public: false,
  include_inferences: false,
  score_to_confidence: true,
}

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

test('validate rejects non-JSON filters', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTERS_JSON'))
})

test('validate accepts a good collection and valid JSON filters', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const withFilters = await validate(ctxOf([{ ...good, filters: '{"mode":"and","filters":[],"filterGroups":[]}' }]))
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

test('buildTaxiiCollectionInput keeps name + set fields and omits blanks', () => {
  const input = buildTaxiiCollectionInput({ name: 'All Malware', description: '', taxii_public: true })
  assert.deepEqual(input, { name: 'All Malware', taxii_public: true })

  const full = buildTaxiiCollectionInput(good)
  assert.equal(full.description, 'Every malware object')
  assert.equal(full.include_inferences, false)
  assert.equal(full.score_to_confidence, true)
})

test('buildTaxiiCollectionPatch sends native JS values and never patches the identity', () => {
  const patch = buildTaxiiCollectionPatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const scoreToConfidence = patch.find((p) => p.key === 'score_to_confidence')
  assert.deepEqual(scoreToConfidence?.value, [true])
  const includeInferences = patch.find((p) => p.key === 'include_inferences')
  assert.deepEqual(includeInferences?.value, [false])
})

test('taxiiCollectionsFromList unwraps the edges/node connection', () => {
  const list = taxiiCollectionsFromList({
    taxiiCollections: { edges: [{ node: { id: '1', name: 'All Malware' } }, { node: { id: '2', name: 'All Reports' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findTaxiiCollection(list, 'all malware')?.id, '1')
})
