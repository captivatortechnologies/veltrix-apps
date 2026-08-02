import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildPipelineBody,
  deepSubsetEqual,
  extractPipelineSpec,
  findPipelineByName,
  isReadOnlyPipeline,
  parseJsonArray,
  pipelineKey,
  pipelineToBody,
  stableStringify,
  type LogPipeline,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/healthCheck/driftDetect handlers apply over the Datadog
 * API via lib/datadogApi (global fetch), which is impractical to mock here.
 * Tests focus on validate.ts and the pure _shared helpers, which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'nginx-custom',
  description: 'Custom nginx enrichment',
  is_enabled: true,
  filter_query: 'source:nginx',
  processors: JSON.stringify([{ type: 'date-remapper', name: 'Define log date', sources: ['timestamp'], is_enabled: true }]),
}

// --- validate ------------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed pipeline', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name longer than 255 characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'x'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate requires processors and rejects malformed JSON', async () => {
  const empty = await validate(ctxOf([{ ...good, processors: '' }]))
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_PROCESSORS'))

  const bad = await validate(ctxOf([{ ...good, processors: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_PROCESSORS_JSON'))
})

test('validate rejects an unsupported processor type', async () => {
  const res = await validate(ctxOf([{ ...good, processors: JSON.stringify([{ type: 'made-up-processor' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROCESSOR_TYPE'))
})

test('validate rejects a non-boolean processor is_enabled', async () => {
  const res = await validate(ctxOf([{ ...good, processors: JSON.stringify([{ type: 'date-remapper', is_enabled: 'yes' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROCESSOR_ENABLED'))
})

test('validate rejects a duplicate pipeline name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers -------------------------------------------------------------

test('extractPipelineSpec trims fields and defaults is_enabled to true', () => {
  const spec = extractPipelineSpec({ name: '  Spaced  ' })
  assert.equal(spec.name, 'Spaced')
  assert.equal(spec.isEnabled, true)
  assert.equal(spec.filterQuery, '')
})

test('pipelineKey normalizes case and whitespace', () => {
  assert.equal(pipelineKey('  Nginx Custom '), 'nginx custom')
})

test('findPipelineByName matches case-insensitively', () => {
  const pipelines: LogPipeline[] = [{ id: 'p1', name: 'Nginx Custom' }, { id: 'p2', name: 'Other' }]
  assert.equal(findPipelineByName(pipelines, 'nginx custom')?.id, 'p1')
  assert.equal(findPipelineByName(pipelines, 'missing'), null)
})

test('isReadOnlyPipeline flags only is_read_only === true', () => {
  assert.equal(isReadOnlyPipeline({ is_read_only: true }), true)
  assert.equal(isReadOnlyPipeline({ is_read_only: false }), false)
  assert.equal(isReadOnlyPipeline({}), false)
  assert.equal(isReadOnlyPipeline(null), false)
})

test('parseJsonArray accepts empty text as ok-but-undefined and rejects non-arrays', () => {
  assert.deepEqual(parseJsonArray(''), { value: undefined, ok: true })
  assert.equal(parseJsonArray('{"a":1}').ok, false)
  assert.deepEqual(parseJsonArray('[1,2]'), { value: [1, 2], ok: true })
})

test('buildPipelineBody assembles the full write body', () => {
  const spec = extractPipelineSpec(good)
  const body = buildPipelineBody(spec, [{ type: 'date-remapper' }])
  assert.equal(body.name, 'nginx-custom')
  assert.equal(body.filter.query, 'source:nginx')
  assert.deepEqual(body.processors, [{ type: 'date-remapper' }])
})

test('pipelineToBody rebuilds a body from a captured live pipeline, defaulting missing fields', () => {
  const pipeline: LogPipeline = { name: 'P', is_enabled: false }
  const body = pipelineToBody(pipeline)
  assert.equal(body.name, 'P')
  assert.equal(body.is_enabled, false)
  assert.deepEqual(body.processors, [])
  assert.equal(body.filter.query, '')
})

test('deepSubsetEqual matches a declared subset even with extra live keys', () => {
  const expected = [{ type: 'date-remapper', sources: ['timestamp'] }]
  const actual = [{ type: 'date-remapper', sources: ['timestamp'], name: '', is_enabled: true }]
  assert.equal(deepSubsetEqual(expected, actual), true)
})

test('deepSubsetEqual detects a changed value', () => {
  assert.equal(deepSubsetEqual([{ type: 'grok-parser' }], [{ type: 'date-remapper' }]), false)
})

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})
