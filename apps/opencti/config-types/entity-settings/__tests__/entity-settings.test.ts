import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildEntitySettingPatch, buildRestorePatch, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus
 * on validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.target_type ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  target_type: 'Report',
  platform_hidden_type: false,
  enforce_reference: true,
  platform_entity_files_ref: false,
  attributes_configuration: '{"description":{"mandatory":true}}',
  overview_layout_customization: '[{"key":"details","width":6,"label":"Details"}]',
}

test('validate rejects a missing target_type', async () => {
  const res = await validate(ctxOf([{ ...good, target_type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TARGET_TYPE'))
})

test('validate warns on a duplicate target_type', async () => {
  const res = await validate(ctxOf([good, { ...good, enforce_reference: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TARGET_TYPE'))
})

test('validate rejects malformed attributes_configuration JSON', async () => {
  const res = await validate(ctxOf([{ ...good, attributes_configuration: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ATTRIBUTES_CONFIGURATION_JSON'))
})

test('validate rejects malformed / non-array overview_layout_customization', async () => {
  const malformed = await validate(ctxOf([{ ...good, overview_layout_customization: '{bad' }]))
  assert.ok(malformed.errors.some((e) => e.code === 'INVALID_OVERVIEW_LAYOUT_JSON'))

  const notArray = await validate(ctxOf([{ ...good, overview_layout_customization: '{}' }]))
  assert.ok(notArray.errors.some((e) => e.code === 'INVALID_OVERVIEW_LAYOUT_SHAPE'))
})

test('validate accepts a good entity setting and a target_type-only one', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true, JSON.stringify(full.errors))

  const bare = await validate(ctxOf([{ target_type: 'Indicator' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeBool falls back when blank and coerces checkbox-ish values', () => {
  assert.equal(normalizeBool(true, false), true)
  assert.equal(normalizeBool('', false), false)
  assert.equal(normalizeBool(undefined, true), true)
  assert.equal(normalizeBool('false', true), false)
})

test('buildEntitySettingPatch always sends the three booleans and only sends JSON fields when non-blank', () => {
  const patch = buildEntitySettingPatch({ target_type: 'Report' })
  assert.deepEqual(patch.find((p) => p.key === 'platform_hidden_type')?.value, [false])
  assert.equal(patch.some((p) => p.key === 'attributes_configuration'), false)

  const full = buildEntitySettingPatch(good)
  assert.deepEqual(full.find((p) => p.key === 'enforce_reference')?.value, [true])
  assert.deepEqual(full.find((p) => p.key === 'attributes_configuration')?.value, ['{"description":{"mandatory":true}}'])
  const overviewLayout = full.find((p) => p.key === 'overview_layout_customization')
  assert.deepEqual(overviewLayout?.value, [{ key: 'details', width: 6, label: 'Details' }])
})

test('buildRestorePatch reconstructs all five fields from a prior live setting', () => {
  const prior = {
    platform_hidden_type: true,
    enforce_reference: false,
    platform_entity_files_ref: true,
    attributes_configuration: '{}',
    overview_layout_customization: [{ key: 'details', width: 6, label: 'Details' }],
  }
  const patch = buildRestorePatch(prior)
  assert.deepEqual(patch.find((p) => p.key === 'platform_hidden_type')?.value, [true])
  assert.deepEqual(patch.find((p) => p.key === 'overview_layout_customization')?.value, prior.overview_layout_customization)
})
