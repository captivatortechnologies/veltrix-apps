import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildMonitorCreateBody,
  buildMonitorUpdateBody,
  canonicalJson,
  findMonitorChild,
  parseJsonArray,
  tryParseJsonArray,
  type MonitorsLibraryChild,
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
  name: 'High Error Rate',
  monitorType: 'Logs',
  queries: '[{"rowId":"A","query":"error | count"}]',
  triggers: '[{"detectionMethod":"LogsStaticCondition","triggerType":"Critical","timeRange":"15m","threshold":50,"thresholdType":"GreaterThanOrEqual"}]',
  notifications: '[]',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed monitor', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid monitor type', async () => {
  const res = await validate(ctxOf([{ ...good, monitorType: 'Traces' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MONITOR_TYPE'))
})

test('validate rejects malformed queries JSON', async () => {
  const res = await validate(ctxOf([{ ...good, queries: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUERIES_JSON'))
})

test('validate rejects an empty queries array', async () => {
  const res = await validate(ctxOf([{ ...good, queries: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERIES'))
})

test('validate rejects a query object missing "query"', async () => {
  const res = await validate(ctxOf([{ ...good, queries: '[{"rowId":"A"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUERY_SHAPE'))
})

test('validate rejects a trigger missing "triggerType"', async () => {
  const res = await validate(ctxOf([{ ...good, triggers: '[{"detectionMethod":"LogsStaticCondition"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TRIGGER_SHAPE'))
})

test('validate warns when there are no notifications', async () => {
  const res = await validate(ctxOf([good]))
  assert.ok(res.warnings.some((w) => w.code === 'NO_NOTIFICATIONS'))
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

test('parseJsonArray accepts JSON strings, arrays, and blanks', () => {
  assert.deepEqual(parseJsonArray('[1,2]', 'x'), [1, 2])
  assert.deepEqual(parseJsonArray([1, 2], 'x'), [1, 2])
  assert.deepEqual(parseJsonArray('', 'x'), [])
})

test('parseJsonArray throws on malformed JSON or non-array', () => {
  assert.throws(() => parseJsonArray('{not json', 'x'))
  assert.throws(() => parseJsonArray('{"a":1}', 'x'))
})

test('tryParseJsonArray returns null instead of throwing', () => {
  assert.equal(tryParseJsonArray('{not json', 'x'), null)
  assert.deepEqual(tryParseJsonArray('[1]', 'x'), [1])
})

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }))
})

test('buildMonitorCreateBody sets type and parses JSON blobs', () => {
  const body = buildMonitorCreateBody(good)
  assert.equal(body.type, 'MonitorsLibraryMonitor')
  assert.deepEqual(body.queries, [{ rowId: 'A', query: 'error | count' }])
  assert.equal('notifications' in body, false) // empty array omitted
})

test('buildMonitorUpdateBody includes the given version', () => {
  const body = buildMonitorUpdateBody(good, 7)
  assert.equal(body.version, 7)
})

test('findMonitorChild matches Monitor-type children by name, ignores folders', () => {
  const children: MonitorsLibraryChild[] = [
    { id: '1', name: 'High Error Rate', contentType: 'Monitor', version: 1 },
    { id: '2', name: 'High Error Rate', contentType: 'Folder', version: 1 },
  ]
  assert.equal(findMonitorChild(children, 'high error rate')?.id, '1')
  assert.equal(findMonitorChild(children, 'missing'), null)
  assert.equal(findMonitorChild(undefined, 'x'), null)
})
