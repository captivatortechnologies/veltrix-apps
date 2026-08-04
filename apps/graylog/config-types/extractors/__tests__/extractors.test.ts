import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildExtractorBody, bodyFromLiveExtractor, extractorsFromList, findExtractor } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers (body building, identity
 * matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  input_title: 'Syslog UDP',
  title: 'Extract client IP',
  extractor_type: 'GROK',
  cursor_strategy: 'COPY',
  source_field: 'message',
  target_field: 'client_ip',
  extractor_config: '{"grok_pattern":"%{IP:client_ip}"}',
  converters: '[]',
  condition_type: 'NONE',
  order: 0,
}

test('validate accepts a well-formed extractor', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing input title', async () => {
  const res = await validate(ctxOf([{ ...good, input_title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INPUT_TITLE'))
})

test('validate rejects an unknown extractor type', async () => {
  const res = await validate(ctxOf([{ ...good, extractor_type: 'NOPE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a condition requiring a value with none given', async () => {
  const res = await validate(ctxOf([{ ...good, condition_type: 'STRING', condition_value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_CONDITION_VALUE'))
})

test('validate rejects a missing target field', async () => {
  const res = await validate(ctxOf([{ ...good, target_field: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TARGET_FIELD'))
})

test('validate warns on a duplicate (input, title) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, target_field: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildExtractorBody normalizes fields and parses JSON', () => {
  const { body, error } = buildExtractorBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.extractor_type, 'GROK')
  assert.deepEqual(body?.extractor_config, { grok_pattern: '%{IP:client_ip}' })
  assert.deepEqual(body?.converters, [])
})

test('buildExtractorBody surfaces a converters parse error', () => {
  const { error } = buildExtractorBody({ ...good, converters: 'nope' })
  assert.ok(error && error.startsWith('converters'))
})

test('bodyFromLiveExtractor maps a live extractor back to a request body', () => {
  const body = bodyFromLiveExtractor({ title: 'x', type: 'JSON', target_field: 'y', extractor_config: { flatten: true } })
  assert.equal(body.extractor_type, 'JSON')
  assert.deepEqual(body.extractor_config, { flatten: true })
})

test('extractorsFromList + findExtractor match by title from the API envelope', () => {
  const live = extractorsFromList({ extractors: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] })
  assert.equal(live.length, 2)
  assert.equal(findExtractor(live, 'B')?.id, '2')
  assert.equal(findExtractor(live, 'nope'), null)
})
