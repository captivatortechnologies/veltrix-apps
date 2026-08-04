import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildScheduledViewCreateBody,
  buildScheduledViewUpdateBody,
  findScheduledView,
  scheduledViewsFromList,
  toRetentionDays,
  normalizeBool,
  type ScheduledView,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.indexName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  indexName: 'nginx_view',
  query: '_sourceCategory=*/Apache',
  startTime: '2026-01-01T00:00:00Z',
  retentionPeriod: 60,
  parsingMode: 'AutoParse',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed scheduled view', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing index name', async () => {
  const res = await validate(ctxOf([{ ...good, indexName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INDEX_NAME'))
})

test('validate rejects a missing query', async () => {
  const res = await validate(ctxOf([{ ...good, query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate rejects a malformed start time', async () => {
  const res = await validate(ctxOf([{ ...good, startTime: 'not-a-date' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_START_TIME'))
})

test('validate rejects an invalid parsing mode', async () => {
  const res = await validate(ctxOf([{ ...good, parsingMode: 'Auto' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PARSING_MODE'))
})

test('validate rejects retention below -1', async () => {
  const res = await validate(ctxOf([{ ...good, retentionPeriod: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION'))
})

test('validate warns on a duplicate index name', async () => {
  const res = await validate(ctxOf([good, { ...good, query: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_INDEX_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('toRetentionDays parses whole days and preserves -1', () => {
  assert.equal(toRetentionDays(30), 30)
  assert.equal(toRetentionDays('45'), 45)
  assert.equal(toRetentionDays(-1), -1)
  assert.equal(toRetentionDays(''), undefined)
})

test('normalizeBool coerces booleans and strings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('no'), false)
})

test('buildScheduledViewCreateBody includes the immutable identity fields', () => {
  const body = buildScheduledViewCreateBody(good)
  assert.equal(body.indexName, 'nginx_view')
  assert.equal(body.query, '_sourceCategory=*/Apache')
  assert.equal(body.startTime, '2026-01-01T00:00:00Z')
  assert.equal(body.retentionPeriod, 60)
  assert.equal(body.parsingMode, 'AutoParse')
})

test('buildScheduledViewCreateBody defaults retention/parsingMode/timeZone', () => {
  const body = buildScheduledViewCreateBody({ indexName: 'v', query: 'q', startTime: 't' })
  assert.equal(body.retentionPeriod, -1)
  assert.equal(body.parsingMode, 'Manual')
  assert.equal(body.timeZone, 'UTC')
})

test('buildScheduledViewUpdateBody never includes query/indexName/startTime', () => {
  const body = buildScheduledViewUpdateBody(good)
  assert.equal('query' in body, false)
  assert.equal('indexName' in body, false)
  assert.equal('startTime' in body, false)
})

test('buildScheduledViewUpdateBody sets reduceRetentionPeriodImmediately only when lowering retention', () => {
  const existing: ScheduledView = { id: '1', indexName: 'v', query: 'q', retentionPeriod: 90 }
  const lowered = buildScheduledViewUpdateBody({ retentionPeriod: 30, reduceRetentionPeriodImmediately: true }, existing)
  assert.equal(lowered.reduceRetentionPeriodImmediately, true)

  const raised = buildScheduledViewUpdateBody({ retentionPeriod: 120 }, existing)
  assert.equal('reduceRetentionPeriodImmediately' in raised, false)
})

test('scheduledViewsFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const views: ScheduledView[] = [{ id: '1', indexName: 'a', query: 'q' }]
  assert.deepEqual(scheduledViewsFromList({ data: views }), views)
  assert.deepEqual(scheduledViewsFromList(views), views)
  assert.deepEqual(scheduledViewsFromList(null), [])
})

test('findScheduledView matches by index name case-insensitively', () => {
  const views: ScheduledView[] = [{ id: '9', indexName: 'Nginx_View', query: 'q' }]
  assert.equal(findScheduledView(views, 'nginx_view')?.id, '9')
  assert.equal(findScheduledView(views, 'missing'), null)
})
