import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { normalizeEnabled } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ruleId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { ruleId: 'r8ae477067a', enabled: false }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed exception', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing rule id', async () => {
  const res = await validate(ctxOf([{ ...good, ruleId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE_ID'))
})

test('validate warns on a duplicate rule id', async () => {
  const res = await validate(ctxOf([good, { ...good, enabled: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_RULE_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('normalizeEnabled coerces strings and falls back', () => {
  assert.equal(normalizeEnabled('false'), false)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('true'), true)
  assert.equal(normalizeEnabled(undefined, true), true)
  assert.equal(normalizeEnabled('', false), false)
})
