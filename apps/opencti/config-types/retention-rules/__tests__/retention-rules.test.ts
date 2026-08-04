import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildRetentionRuleInput,
  buildRetentionRulePatch,
  findRetentionRule,
  normalizeBool,
  normalizeNumber,
  retentionRulesFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Purge old workbenches', scope: 'workbench', max_retention: 30, retention_unit: 'days', active: true }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, max_retention: 60 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate rejects a missing or invalid scope', async () => {
  const missing = await validate(ctxOf([{ ...good, scope: '' }]))
  assert.equal(missing.valid, false)
  assert.ok(missing.errors.some((e) => e.code === 'EMPTY_SCOPE'))

  const invalid = await validate(ctxOf([{ ...good, scope: 'bogus' }]))
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((e) => e.code === 'INVALID_SCOPE'))
})

test('validate rejects a missing or sub-1 max_retention', async () => {
  const missing = await validate(ctxOf([{ ...good, max_retention: '' }]))
  assert.equal(missing.valid, false)
  assert.ok(missing.errors.some((e) => e.code === 'EMPTY_MAX_RETENTION'))

  const tooLow = await validate(ctxOf([{ ...good, max_retention: 0 }]))
  assert.equal(tooLow.valid, false)
  assert.ok(tooLow.errors.some((e) => e.code === 'INVALID_MAX_RETENTION'))
})

test('validate rejects an invalid retention_unit', async () => {
  const res = await validate(ctxOf([{ ...good, retention_unit: 'weeks' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION_UNIT'))
})

test('validate rejects non-JSON filters', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTERS_JSON'))
})

test('validate accepts a good rule and valid JSON filters', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const withFilters = await validate(ctxOf([{ ...good, filters: '{"mode":"and","filters":[],"filterGroups":[]}' }]))
  assert.equal(withFilters.valid, true)
  assert.equal(withFilters.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeBool and normalizeNumber coerce canvas-ish values', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(''), undefined)
  assert.equal(normalizeNumber('30'), 30)
  assert.equal(normalizeNumber(''), undefined)
  assert.equal(normalizeNumber('abc'), undefined)
})

test('buildRetentionRuleInput keeps required fields and omits blanks', () => {
  const input = buildRetentionRuleInput({ name: 'Purge history', scope: 'history', max_retention: 90 })
  assert.deepEqual(input, { name: 'Purge history', scope: 'history', max_retention: 90 })

  const full = buildRetentionRuleInput(good)
  assert.equal(full.retention_unit, 'days')
  assert.equal(full.active, true)
})

test('buildRetentionRulePatch sends native JS values and never patches the identity', () => {
  const patch = buildRetentionRulePatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const maxRetention = patch.find((p) => p.key === 'max_retention')
  assert.deepEqual(maxRetention?.value, [30])
  const active = patch.find((p) => p.key === 'active')
  assert.deepEqual(active?.value, [true])
})

test('retentionRulesFromList unwraps the edges/node connection', () => {
  const list = retentionRulesFromList({
    retentionRules: { edges: [{ node: { id: '1', name: 'Purge old workbenches' } }, { node: { id: '2', name: 'Purge history' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findRetentionRule(list, 'purge old workbenches')?.id, '1')
})
