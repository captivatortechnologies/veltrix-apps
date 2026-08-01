import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildPartitionCreateBody,
  buildPartitionUpdateBody,
  buildPartitionRestoreBody,
  findPartition,
  normalizeBool,
  partitionsFromList,
  toRetentionDays,
  type Partition,
} from '../_shared'
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
  name: 'prod_nginx',
  routingExpression: '_sourceCategory=prod/nginx',
  retentionPeriod: 30,
  analyticsTier: 'continuous',
  isCompliant: false,
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed partition', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing routing expression', async () => {
  const res = await validate(ctxOf([{ ...good, routingExpression: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROUTING_EXPRESSION'))
})

test('validate rejects a non-numeric retention period', async () => {
  const res = await validate(ctxOf([{ ...good, retentionPeriod: 'forever' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION'))
})

test('validate rejects a retention period below -1', async () => {
  const res = await validate(ctxOf([{ ...good, retentionPeriod: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION'))
})

test('validate accepts -1 (account default) and a blank retention', async () => {
  assert.equal((await validate(ctxOf([{ ...good, retentionPeriod: -1 }]))).valid, true)
  assert.equal((await validate(ctxOf([{ ...good, retentionPeriod: '' }]))).valid, true)
})

test('validate warns on a duplicate partition name', async () => {
  const res = await validate(ctxOf([good, { ...good, routingExpression: '_sourceCategory=other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeBool coerces booleans, strings and numbers', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool(false), false)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool('no'), false)
  assert.equal(normalizeBool(''), false)
})

test('toRetentionDays parses whole days and preserves -1', () => {
  assert.equal(toRetentionDays(30), 30)
  assert.equal(toRetentionDays('45'), 45)
  assert.equal(toRetentionDays(-1), -1)
  assert.equal(toRetentionDays(''), undefined)
  assert.equal(toRetentionDays(null), undefined)
  assert.equal(toRetentionDays('nope'), undefined)
})

test('buildPartitionCreateBody includes name, tier, retention and compliance', () => {
  const body = buildPartitionCreateBody({ name: ' p ', routingExpression: ' r ', analyticsTier: 'frequent', retentionPeriod: '90', isCompliant: true })
  assert.deepEqual(body, { name: 'p', routingExpression: 'r', analyticsTier: 'frequent', retentionPeriod: 90, isCompliant: true })
})

test('buildPartitionCreateBody omits blank optional fields', () => {
  const body = buildPartitionCreateBody({ name: 'p', routingExpression: 'r', analyticsTier: '', retentionPeriod: '', isCompliant: false })
  assert.deepEqual(body, { name: 'p', routingExpression: 'r' })
})

test('buildPartitionUpdateBody never sends name or tier, and only raises compliance', () => {
  const raise = buildPartitionUpdateBody({ routingExpression: 'r', retentionPeriod: 60, isCompliant: true }, { name: 'p', routingExpression: 'old', isCompliant: false })
  assert.deepEqual(raise, { routingExpression: 'r', retentionPeriod: 60, isCompliant: true })
  // already compliant → do not resend isCompliant
  const kept = buildPartitionUpdateBody({ routingExpression: 'r', isCompliant: true }, { name: 'p', routingExpression: 'old', isCompliant: true })
  assert.deepEqual(kept, { routingExpression: 'r' })
  // desired false → never sent (Sumo forbids un-complying)
  const lower = buildPartitionUpdateBody({ routingExpression: 'r', isCompliant: false }, { name: 'p', routingExpression: 'old', isCompliant: true })
  assert.deepEqual(lower, { routingExpression: 'r' })
})

test('buildPartitionRestoreBody rebuilds the mutable subset from a prior snapshot', () => {
  const prior: Partition = { id: '1', name: 'p', routingExpression: 'r', retentionPeriod: 30, isCompliant: true }
  assert.deepEqual(buildPartitionRestoreBody(prior), { routingExpression: 'r', retentionPeriod: 30, isCompliant: true })
})

test('partitionsFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const parts: Partition[] = [{ id: '1', name: 'p', routingExpression: 'r' }]
  assert.deepEqual(partitionsFromList({ data: parts }), parts)
  assert.deepEqual(partitionsFromList(parts), parts)
  assert.deepEqual(partitionsFromList(null), [])
  assert.deepEqual(partitionsFromList({}), [])
})

test('findPartition matches by name case-insensitively', () => {
  const parts: Partition[] = [{ id: '9', name: 'Prod_Nginx', routingExpression: 'r' }]
  assert.equal(findPartition(parts, 'prod_nginx')?.id, '9')
  assert.equal(findPartition(parts, 'missing'), null)
  assert.equal(findPartition(parts, ''), null)
})
