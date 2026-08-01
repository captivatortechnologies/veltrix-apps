import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildDiscoveryViewBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Public internet-facing assets',
  viewType: 'discovery',
  organizationLevel: true,
  query: '{"models":["Inventory"],"type":"object_set"}',
  extraParams: '{"columns2":{"keys":["Name"]}}',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed discovery view', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a non-JSON query', async () => {
  const res = await validate(ctxOf([{ ...good, query: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUERY'))
})

test('validate rejects a query that is a JSON array (not an object)', async () => {
  const res = await validate(ctxOf([{ ...good, query: '[1,2]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUERY'))
})

test('validate accepts a view with no extra params', async () => {
  const res = await validate(ctxOf([{ ...good, extraParams: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects malformed extra params', async () => {
  const res = await validate(ctxOf([{ ...good, extraParams: '{bad}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXTRA_PARAMS'))
})

test('validate warns on a duplicate view name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('buildDiscoveryViewBody nests the query under filter_data.query2', () => {
  const body = buildDiscoveryViewBody(good, { models: ['Inventory'] }, { columns2: { keys: ['Name'] } })
  assert.equal(body.name, good.name)
  assert.equal(body.view_type, 'discovery')
  assert.equal(body.organization_level, true)
  assert.deepEqual(body.filter_data, { query2: { models: ['Inventory'] } })
  assert.deepEqual(body.extra_params, { columns2: { keys: ['Name'] } })
})

test('buildDiscoveryViewBody defaults view type and extra params', () => {
  const body = buildDiscoveryViewBody({ name: 'X', organizationLevel: false }, { a: 1 }, undefined)
  assert.equal(body.view_type, 'discovery')
  assert.equal(body.organization_level, false)
  assert.deepEqual(body.extra_params, {})
})
