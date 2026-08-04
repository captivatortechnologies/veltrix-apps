import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseOverrides, buildSettingsUpdateBody, mergeOverrides, configFromResponse, LIFECYCLE_PLUGIN_NAME, LIFECYCLE_CONFIG_NAME } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

// --- validate ---------------------------------------------------------------

test('validate errors when the singleton item is missing', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate errors when declared more than once', async () => {
  const res = await validate(ctxOf([{ overrides: '{}' }, { overrides: '{}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate rejects invalid JSON overrides', async () => {
  const res = await validate(ctxOf([{ overrides: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OVERRIDES'))
})

test('validate warns on empty overrides', async () => {
  const res = await validate(ctxOf([{ overrides: '{}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_OVERRIDES'))
})

test('validate accepts a populated overrides object', async () => {
  const res = await validate(ctxOf([{ overrides: '{"discovery_settings":{"conditional":{}}}' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('parseOverrides treats blank as an empty object', () => {
  const res = parseOverrides('')
  assert.ok(res.ok)
  assert.deepEqual(res.ok && res.value, {})
})

test('parseOverrides rejects a non-object JSON value', () => {
  const res = parseOverrides('[1,2,3]')
  assert.equal(res.ok, false)
})

test('mergeOverrides shallow-merges, declared keys winning, other keys preserved', () => {
  const merged = mergeOverrides({ a: 1, b: 2 }, { b: 99, c: 3 })
  assert.deepEqual(merged, { a: 1, b: 99, c: 3 })
})

test('buildSettingsUpdateBody wraps config with the settings_schema type and the fixed plugin/config identity', () => {
  const body = buildSettingsUpdateBody({ x: 1 })
  assert.equal(body.data.type, 'settings_schema')
  assert.equal(body.data.attributes.configName, LIFECYCLE_CONFIG_NAME)
  assert.equal(body.data.attributes.pluginId, LIFECYCLE_PLUGIN_NAME)
  assert.deepEqual(body.data.attributes.config, { x: 1 })
})

test('configFromResponse extracts the config object from the JSON:API document', () => {
  const doc = { data: { id: 'x', type: 'settings_schema', attributes: { config: { a: 1 }, configName: 'SystemSchedulerService' } } }
  assert.deepEqual(configFromResponse(doc), { a: 1 })
})

test('configFromResponse returns an empty object for a malformed document', () => {
  assert.deepEqual(configFromResponse({}), {})
  assert.deepEqual(configFromResponse(null), {})
})
