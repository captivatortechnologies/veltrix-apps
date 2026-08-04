import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildLogStreamCreateBody,
  buildLogStreamUpdateBody,
  findLogStreamByName,
  parseJsonArray,
  snapshotLogStream,
  type Auth0LogStream,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'security-siem',
  type: 'http',
  status: 'active',
  sink: '{"httpEndpoint":"https://logs.example.com/ingest","httpContentFormat":"JSONLINES"}',
  filters: '[{"type":"category","name":"auth.login.success"}]',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'carrier-pigeon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an unknown status', async () => {
  const res = await validate(ctxOf([{ ...good, status: 'sleeping' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATUS'))
})

test('validate rejects malformed sink JSON', async () => {
  const res = await validate(ctxOf([{ ...good, sink: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SINK'))
})

test('validate rejects an empty sink object', async () => {
  const res = await validate(ctxOf([{ ...good, sink: '{}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SINK'))
})

test('validate rejects an http sink with no httpEndpoint', async () => {
  const res = await validate(ctxOf([{ ...good, sink: '{"httpContentFormat":"JSONLINES"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_HTTP_ENDPOINT'))
})

test('validate accepts a non-http sink without httpEndpoint', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'datadog', sink: '{"datadogApiKey":"x","datadogRegion":"us"}' }]))
  assert.equal(res.valid, true)
})

test('validate rejects malformed filters JSON', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTERS'))
})

test('validate rejects a filter entry missing type or name', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '[{"type":"category"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER_ENTRY'))
})

test('validate accepts empty filters (deliver every event)', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate log stream name', async () => {
  const res = await validate(ctxOf([good, { ...good, status: 'paused' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers --------------------------------------------------------

test('buildLogStreamCreateBody includes name, type, sink, filters, status', () => {
  const body = buildLogStreamCreateBody(good)
  assert.equal(body.name, 'security-siem')
  assert.equal(body.type, 'http')
  assert.deepEqual(body.sink, { httpEndpoint: 'https://logs.example.com/ingest', httpContentFormat: 'JSONLINES' })
  assert.deepEqual(body.filters, [{ type: 'category', name: 'auth.login.success' }])
  assert.equal(body.status, 'active')
})

test('buildLogStreamUpdateBody omits name and type (immutable) but sends sink whole', () => {
  const body = buildLogStreamUpdateBody(good)
  assert.equal('name' in body, false)
  assert.equal('type' in body, false)
  assert.deepEqual(body.sink, { httpEndpoint: 'https://logs.example.com/ingest', httpContentFormat: 'JSONLINES' })
})

test('buildLogStreamCreateBody omits filters and status when blank', () => {
  const body = buildLogStreamCreateBody({ name: 'x', type: 'http', sink: '{"httpEndpoint":"https://a.example.com"}' })
  assert.equal('filters' in body, false)
  assert.equal('status' in body, false)
})

test('parseJsonArray parses arrays, blanks, and reports errors', () => {
  assert.deepEqual(parseJsonArray(''), { ok: true, value: [] })
  assert.deepEqual(parseJsonArray(undefined), { ok: true, value: [] })
  assert.deepEqual(parseJsonArray('[1,2]'), { ok: true, value: [1, 2] })
  assert.equal(parseJsonArray('{not json').ok, false)
  assert.equal(parseJsonArray('{"a":1}').ok, false)
})

test('findLogStreamByName matches by trimmed name', () => {
  const list: Auth0LogStream[] = [
    { id: 'lst_1', name: 'security-siem' },
    { id: 'lst_2', name: 'audit-datadog' },
  ]
  assert.equal(findLogStreamByName(list, 'audit-datadog')?.id, 'lst_2')
  assert.equal(findLogStreamByName(list, 'missing'), null)
  assert.equal(findLogStreamByName(list, ''), null)
})

test('snapshotLogStream strips secret-bearing sink keys for restore', () => {
  const snap = snapshotLogStream({
    id: 'lst_1',
    name: 'security-siem',
    type: 'splunk',
    status: 'active',
    sink: { splunkDomain: 'x.splunkcloud.com', splunkToken: 'shh', splunkPort: '8088', splunkSecure: 'true' },
    filters: [{ type: 'category', name: 'auth.login.fail' }],
  })
  assert.deepEqual(snap.sink, { splunkDomain: 'x.splunkcloud.com', splunkPort: '8088', splunkSecure: 'true' })
  assert.deepEqual(snap.filters, [{ type: 'category', name: 'auth.login.fail' }])
  assert.equal(snap.status, 'active')
})
