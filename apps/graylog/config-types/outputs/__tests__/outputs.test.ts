import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildOutputBody, bodyFromLiveOutput, outputsFromList, findOutput, GELF_OUTPUT_TYPE } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'Forward to SIEM',
  type: GELF_OUTPUT_TYPE,
  configuration: '{"protocol":"TCP","hostname":"siem.internal","port":12201}',
}

test('validate accepts a well-formed output', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate warns on a non-fully-qualified type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'GelfOutput' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPICIOUS_TYPE'))
})

test('validate rejects malformed configuration JSON', async () => {
  const res = await validate(ctxOf([{ ...good, configuration: '{ nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG_JSON'))
})

test('validate warns on a duplicate title', async () => {
  const res = await validate(ctxOf([good, { ...good, configuration: '{"port":12202}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildOutputBody parses configuration and normalizes fields', () => {
  const { body, error } = buildOutputBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.type, GELF_OUTPUT_TYPE)
  assert.deepEqual(body?.configuration, { protocol: 'TCP', hostname: 'siem.internal', port: 12201 })
})

test('bodyFromLiveOutput maps a live output back to a request body', () => {
  const body = bodyFromLiveOutput({ title: 'x', type: GELF_OUTPUT_TYPE, configuration: { port: 1 } })
  assert.deepEqual(body.configuration, { port: 1 })
})

test('outputsFromList + findOutput match by title from the API envelope', () => {
  const live = outputsFromList({ total: 2, outputs: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] })
  assert.equal(live.length, 2)
  assert.equal(findOutput(live, 'B')?.id, '2')
  assert.equal(findOutput(live, 'nope'), null)
})
