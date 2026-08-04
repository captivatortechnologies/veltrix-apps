import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parsePipelineTitles, findConnectionsByStreamId } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers (title-list parsing, identity
 * matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.stream_title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { stream_title: 'Firewall', pipeline_titles: '["route-firewall","enrich-geoip"]' }

test('validate accepts a well-formed connection', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing stream title', async () => {
  const res = await validate(ctxOf([{ ...good, stream_title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_STREAM_TITLE'))
})

test('validate rejects malformed pipeline_titles JSON', async () => {
  const res = await validate(ctxOf([{ ...good, pipeline_titles: '{ nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PIPELINE_TITLES_JSON'))
})

test('validate warns on an empty pipeline list (disconnects everything)', async () => {
  const res = await validate(ctxOf([{ ...good, pipeline_titles: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_PIPELINE_LIST'))
})

test('validate warns on a duplicate stream', async () => {
  const res = await validate(ctxOf([good, { ...good, pipeline_titles: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_STREAM'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parsePipelineTitles accepts a JSON array of strings', () => {
  const { titles, error } = parsePipelineTitles('["a","b"]')
  assert.equal(error, undefined)
  assert.deepEqual(titles, ['a', 'b'])
})

test('parsePipelineTitles treats blank as an empty list', () => {
  assert.deepEqual(parsePipelineTitles('').titles, [])
  assert.deepEqual(parsePipelineTitles(null).titles, [])
})

test('parsePipelineTitles rejects a non-array JSON value', () => {
  const { error } = parsePipelineTitles('{"a":1}')
  assert.ok(error)
})

test('findConnectionsByStreamId matches by stream_id', () => {
  const all = [{ id: 'c1', stream_id: 's1', pipeline_ids: ['p1'] }, { id: 'c2', stream_id: 's2', pipeline_ids: [] }]
  assert.equal(findConnectionsByStreamId(all, 's2')?.id, 'c2')
  assert.equal(findConnectionsByStreamId(all, 'nope'), null)
})
