import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildLogSearchCreateBody,
  buildLogSearchUpdateBody,
  findLogSearchChild,
  isValidJsonField,
  normalizeBool,
  type ContentChild,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Failed Logins',
  queryString: '_sourceCategory=auth error | count by user',
  timeRange: '{"type":"BeginBoundedTimeRange","from":{"type":"RelativeTimeRangeBoundary","relativeTime":"-15m"}}',
  parsingMode: 'Manual',
  intervalTimeType: 'messageTime',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed log search', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an illegal name character', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad/name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a missing query', async () => {
  const res = await validate(ctxOf([{ ...good, queryString: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate rejects malformed JSON blobs', async () => {
  const res = await validate(ctxOf([{ ...good, timeRange: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIME_RANGE_JSON'))
})

test('validate rejects an invalid parsingMode/intervalTimeType', async () => {
  const r1 = await validate(ctxOf([{ ...good, parsingMode: 'Auto' }]))
  assert.ok(r1.errors.some((e) => e.code === 'INVALID_PARSING_MODE'))
  const r2 = await validate(ctxOf([{ ...good, intervalTimeType: 'wallClock' }]))
  assert.ok(r2.errors.some((e) => e.code === 'INVALID_INTERVAL_TIME_TYPE'))
})

test('validate warns on a duplicate (parentId, name) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('isValidJsonField accepts blank and well-formed JSON, rejects malformed', () => {
  assert.equal(isValidJsonField(''), true)
  assert.equal(isValidJsonField('{"a":1}'), true)
  assert.equal(isValidJsonField('{not json'), false)
})

test('normalizeBool coerces booleans and strings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('no'), false)
})

test('buildLogSearchCreateBody includes parentId; update body omits it', () => {
  const created = buildLogSearchCreateBody(good, 'folder-1')
  assert.equal(created.parentId, 'folder-1')
  const updated = buildLogSearchUpdateBody(good)
  assert.equal('parentId' in updated, false)
})

test('findLogSearchChild matches Search-type children by name, ignores other content types', () => {
  const children: ContentChild[] = [
    { id: '1', name: 'Failed Logins', itemType: 'Search' },
    { id: '2', name: 'Failed Logins', itemType: 'Dashboard' },
  ]
  assert.equal(findLogSearchChild(children, 'failed logins')?.id, '1')
  assert.equal(findLogSearchChild(children, 'missing'), null)
})
