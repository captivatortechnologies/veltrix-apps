import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildIngestBudgetBody, findIngestBudget, ingestBudgetsFromList, toCapacityBytes, type IngestBudget } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Dev Budget',
  scope: '_sourceCategory=*dev*',
  capacityBytes: 1_000_000_000,
  action: 'keepCollecting',
  resetTime: '00:00',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed budget', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing scope', async () => {
  const res = await validate(ctxOf([{ ...good, scope: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPE'))
})

test('validate rejects a non-positive capacity', async () => {
  const res = await validate(ctxOf([{ ...good, capacityBytes: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CAPACITY'))
})

test('validate rejects an invalid action', async () => {
  const res = await validate(ctxOf([{ ...good, action: 'destroy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate rejects a malformed reset time', async () => {
  const res = await validate(ctxOf([{ ...good, resetTime: '25:00' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RESET_TIME'))
})

test('validate warns when action is stopCollecting', async () => {
  const res = await validate(ctxOf([{ ...good, action: 'stopCollecting' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'STOP_COLLECTING_IMPACT'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, scope: '_sourceCategory=*other*' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('toCapacityBytes accepts positive integers, rejects zero/negative/non-numeric', () => {
  assert.equal(toCapacityBytes(1000), 1000)
  assert.equal(toCapacityBytes('500'), 500)
  assert.equal(toCapacityBytes(0), undefined)
  assert.equal(toCapacityBytes(-5), undefined)
  assert.equal(toCapacityBytes('nope'), undefined)
})

test('buildIngestBudgetBody defaults action/timezone/resetTime', () => {
  const body = buildIngestBudgetBody({ name: 'n', scope: 's', capacityBytes: 100 })
  assert.equal(body.action, 'keepCollecting')
  assert.equal(body.timezone, 'Etc/UTC')
  assert.equal(body.resetTime, '00:00')
})

test('buildIngestBudgetBody clamps auditThreshold to 1-99', () => {
  const withinRange = buildIngestBudgetBody({ ...good, auditThreshold: 85 })
  assert.equal(withinRange.auditThreshold, 85)
  const outOfRange = buildIngestBudgetBody({ ...good, auditThreshold: 150 })
  assert.equal('auditThreshold' in outOfRange, false)
})

test('ingestBudgetsFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const budgets: IngestBudget[] = [{ id: '1', name: 'a', scope: 's', capacityBytes: 1, action: 'keepCollecting' }]
  assert.deepEqual(ingestBudgetsFromList({ data: budgets }), budgets)
  assert.deepEqual(ingestBudgetsFromList(budgets), budgets)
  assert.deepEqual(ingestBudgetsFromList(null), [])
})

test('findIngestBudget matches by name case-insensitively', () => {
  const budgets: IngestBudget[] = [{ id: '9', name: 'Dev Budget', scope: 's', capacityBytes: 1, action: 'keepCollecting' }]
  assert.equal(findIngestBudget(budgets, 'dev budget')?.id, '9')
  assert.equal(findIngestBudget(budgets, 'missing'), null)
})
