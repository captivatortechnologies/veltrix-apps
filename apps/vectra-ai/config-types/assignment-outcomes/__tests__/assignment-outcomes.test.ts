import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildOutcomeBody, outcomesFromList, findOutcome } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (body building, envelope unwrapping, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { title: 'Confirmed Phishing', category: 'malicious_true_positive' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good outcome', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects an unknown category', async () => {
  const res = await validate(ctxOf([{ ...good, category: 'made-up' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATEGORY'))
})

test('validate warns on a duplicate title', async () => {
  const res = await validate(ctxOf([good, { ...good, category: 'false_positive' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('buildOutcomeBody trims title and category', () => {
  assert.deepEqual(buildOutcomeBody({ title: '  Confirmed Phishing  ', category: ' malicious_true_positive ' }), {
    title: 'Confirmed Phishing',
    category: 'malicious_true_positive',
  })
})

test('outcomesFromList unwraps the DRF results envelope', () => {
  assert.deepEqual(outcomesFromList({ count: 1, results: [{ id: 1 }] }), [{ id: 1 }])
  assert.deepEqual(outcomesFromList([{ id: 2 }]), [{ id: 2 }])
  assert.deepEqual(outcomesFromList(null), [])
})

test('findOutcome matches by title', () => {
  const outcomes = [{ id: 1, title: 'A' }, { id: 2, title: 'B' }]
  assert.equal(findOutcome(outcomes, 'B')?.id, 2)
  assert.equal(findOutcome(outcomes, 'C'), null)
})
