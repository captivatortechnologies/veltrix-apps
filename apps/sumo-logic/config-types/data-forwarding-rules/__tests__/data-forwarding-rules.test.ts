import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildRuleCreateBody,
  buildRuleUpdateBody,
  findRuleByIndexId,
  normalizeEnabled,
  rulesFromList,
  type DataForwardingRule,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.indexId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { indexId: '000000000001', destinationId: '000000000002', enabled: true, format: 'csv' }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing indexId', async () => {
  const res = await validate(ctxOf([{ ...good, indexId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INDEX_ID'))
})

test('validate rejects a missing destinationId', async () => {
  const res = await validate(ctxOf([{ ...good, destinationId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESTINATION_ID'))
})

test('validate rejects an invalid payloadSchema/format', async () => {
  const r1 = await validate(ctxOf([{ ...good, payloadSchema: 'weird' }]))
  assert.ok(r1.errors.some((e) => e.code === 'INVALID_PAYLOAD_SCHEMA'))
  const r2 = await validate(ctxOf([{ ...good, format: 'weird' }]))
  assert.ok(r2.errors.some((e) => e.code === 'INVALID_FORMAT'))
})

test('validate warns when format/payloadSchema are mismatched', async () => {
  const res = await validate(ctxOf([{ ...good, format: 'text', payloadSchema: 'allFields' }]))
  assert.ok(res.warnings.some((w) => w.code === 'MISMATCHED_FORMAT_SCHEMA'))
})

test('validate warns on a duplicate indexId', async () => {
  const res = await validate(ctxOf([good, { ...good, destinationId: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_INDEX_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeEnabled defaults to true when unset', () => {
  assert.equal(normalizeEnabled(undefined), true)
  assert.equal(normalizeEnabled(false), false)
  assert.equal(normalizeEnabled('no'), false)
})

test('buildRuleCreateBody includes indexId and destinationId', () => {
  const body = buildRuleCreateBody(good)
  assert.equal(body.indexId, '000000000001')
  assert.equal(body.destinationId, '000000000002')
})

test('buildRuleUpdateBody omits indexId', () => {
  const body = buildRuleUpdateBody(good)
  assert.equal('indexId' in body, false)
  assert.equal(body.destinationId, '000000000002')
})

test('rulesFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const rules: DataForwardingRule[] = [{ indexId: '1', destinationId: '2', enabled: true }]
  assert.deepEqual(rulesFromList({ data: rules }), rules)
  assert.deepEqual(rulesFromList(rules), rules)
  assert.deepEqual(rulesFromList(null), [])
})

test('findRuleByIndexId matches by exact (trimmed) indexId', () => {
  const rules: DataForwardingRule[] = [{ indexId: '000000000001', destinationId: '2' }]
  assert.equal(findRuleByIndexId(rules, '000000000001')?.destinationId, '2')
  assert.equal(findRuleByIndexId(rules, 'missing'), null)
})
