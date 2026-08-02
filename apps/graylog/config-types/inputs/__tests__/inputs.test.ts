import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildInputBody, bodyFromLiveInput, inputsFromList, findInput } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (body building, identity matching, the
 * attributes→configuration mapping).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'GELF UDP',
  type: 'org.graylog2.inputs.gelf.udp.GELFUDPInput',
  global: true,
  configuration: '{"bind_address":"0.0.0.0","port":12201}',
}

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
  const res = await validate(ctxOf([{ ...good, type: 'GELFUDPInput' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPICIOUS_TYPE'))
})

test('validate rejects malformed configuration JSON', async () => {
  const res = await validate(ctxOf([{ ...good, configuration: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG_JSON'))
})

test('validate rejects a configuration array (must be an object)', async () => {
  const res = await validate(ctxOf([{ ...good, configuration: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG_JSON'))
})

test('validate warns when a non-global input has no node', async () => {
  const res = await validate(ctxOf([{ ...good, global: false, node: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NON_GLOBAL_NEEDS_NODE'))
})

test('validate warns on a duplicate input title', async () => {
  const res = await validate(ctxOf([good, { ...good, configuration: '{"port":12202}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildInputBody parses configuration and normalizes fields', () => {
  const { body, error } = buildInputBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.title, 'GELF UDP')
  assert.equal(body?.global, true)
  assert.deepEqual(body?.configuration, { bind_address: '0.0.0.0', port: 12201 })
})

test('buildInputBody surfaces a configuration parse error', () => {
  const { body, error } = buildInputBody({ ...good, configuration: 'nope' })
  assert.equal(body, undefined)
  assert.ok(error && error.startsWith('configuration'))
})

test('bodyFromLiveInput maps the live attributes back onto configuration', () => {
  const body = bodyFromLiveInput({
    id: 'abc',
    title: 'GELF UDP',
    type: 'org.graylog2.inputs.gelf.udp.GELFUDPInput',
    global: true,
    attributes: { bind_address: '0.0.0.0', port: 12201 },
  })
  assert.deepEqual(body.configuration, { bind_address: '0.0.0.0', port: 12201 })
  assert.equal(body.title, 'GELF UDP')
})

test('inputsFromList + findInput match by title from the API envelope', () => {
  const live = inputsFromList({ total: 2, inputs: [{ id: '1', title: 'GELF UDP' }, { id: '2', title: 'Syslog' }] })
  assert.equal(live.length, 2)
  assert.equal(findInput(live, 'Syslog')?.id, '2')
  assert.equal(findInput(live, 'Nope'), null)
})
