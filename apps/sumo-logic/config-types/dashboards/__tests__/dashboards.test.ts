import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildDashboardBody,
  findDashboardChild,
  isValidJsonField,
  isValidRefreshInterval,
  normalizeBool,
  parseJsonField,
  type ContentChild,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'Security Overview',
  timeRange: '{"type":"BeginBoundedTimeRange","from":{"type":"RelativeTimeRangeBoundary","relativeTime":"-1h"}}',
  panels: '[]',
  layout: '{"layoutType":"Grid","layoutStructures":[]}',
  variables: '[]',
  refreshInterval: 300,
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed dashboard', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects malformed JSON blobs', async () => {
  const res = await validate(ctxOf([{ ...good, timeRange: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIME_RANGE_JSON'))
})

test('validate rejects an invalid refresh interval', async () => {
  const res = await validate(ctxOf([{ ...good, refreshInterval: 45 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REFRESH_INTERVAL'))
})

test('validate warns on a public dashboard', async () => {
  const res = await validate(ctxOf([{ ...good, isPublic: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PUBLIC_DASHBOARD'))
})

test('validate warns on a duplicate (folderId, title) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('isValidRefreshInterval accepts only the documented values', () => {
  assert.equal(isValidRefreshInterval(300), true)
  assert.equal(isValidRefreshInterval(0), true)
  assert.equal(isValidRefreshInterval(''), true)
  assert.equal(isValidRefreshInterval(45), false)
})

test('isValidJsonField / parseJsonField agree on well-formed and malformed JSON', () => {
  assert.equal(isValidJsonField('[1,2]'), true)
  assert.deepEqual(parseJsonField('[1,2]', 'x'), [1, 2])
  assert.equal(isValidJsonField('{not json'), false)
})

test('normalizeBool coerces booleans and strings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('no'), false)
})

test('buildDashboardBody defaults theme/timeRange/panels/layout when blank', () => {
  const body = buildDashboardBody({ title: 't' })
  assert.equal(body.theme, 'Light')
  assert.deepEqual(body.panels, [])
  assert.ok(body.timeRange)
})

test('findDashboardChild matches Dashboard-type children by title, ignores other content types', () => {
  const children: ContentChild[] = [
    { id: '1', name: 'Security Overview', itemType: 'Dashboard' },
    { id: '2', name: 'Security Overview', itemType: 'Folder' },
  ]
  assert.equal(findDashboardChild(children, 'security overview')?.id, '1')
  assert.equal(findDashboardChild(children, 'missing'), null)
})
