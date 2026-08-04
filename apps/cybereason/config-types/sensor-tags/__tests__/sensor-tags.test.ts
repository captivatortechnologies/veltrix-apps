import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildTagOps,
  buildProcessTagsBody,
  assertTagsApplied,
  sensorsFromResponse,
  buildPylumIdQuery,
  extractTagSnapshot,
  buildTagOpsFromSnapshot,
  normalizeCriticalAsset,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Cybereason REST API via
 * node:https, which is impractical to mock here. Tests focus on validate.ts and
 * the pure _shared helpers — network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.pylumId ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { pylumId: 'abc123', department: 'IT', location: 'HQ', deviceType: 'Laptop', criticalAsset: 'true', customTags: 'exec-laptop' }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed tag set', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing pylumId', async () => {
  const res = await validate(ctxOf([{ ...good, pylumId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PYLUM_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a custom tag longer than 100 characters', async () => {
  const res = await validate(ctxOf([{ ...good, customTags: 'x'.repeat(101) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'TAG_TOO_LONG'))
})

test('validate rejects an invalid criticalAsset value', async () => {
  const res = await validate(ctxOf([{ ...good, criticalAsset: 'maybe' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CRITICAL_ASSET'))
})

test('validate warns on a duplicate pylumId', async () => {
  const res = await validate(ctxOf([good, { ...good, location: 'Branch' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_PYLUM_ID'))
})

test('validate warns when every tag field is blank (deploy would clear all tags)', async () => {
  const res = await validate(ctxOf([{ pylumId: 'abc123' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ALL_TAGS_BLANK'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeCriticalAsset only accepts blank/true/false', () => {
  assert.equal(normalizeCriticalAsset(''), '')
  assert.equal(normalizeCriticalAsset('true'), 'true')
  assert.equal(normalizeCriticalAsset('FALSE'), 'false')
  assert.equal(normalizeCriticalAsset('maybe'), '')
})

test('buildTagOps sends SET for populated fields and REMOVE for blank ones, using literal wire keys', () => {
  const ops = buildTagOps({ pylumId: 'x', department: 'IT', location: '', deviceType: 'Laptop', criticalAsset: 'true', customTags: '' })
  assert.deepEqual(ops['department'], { operation: 'SET', value: 'IT' })
  assert.deepEqual(ops['location'], { operation: 'REMOVE' })
  assert.deepEqual(ops['device type'], { operation: 'SET', value: 'Laptop' })
  assert.deepEqual(ops['critical asset'], { operation: 'SET', value: true })
  assert.deepEqual(ops['custom tags'], { operation: 'REMOVE' })
})

test('buildTagOps removes criticalAsset when left unset (tri-state)', () => {
  const ops = buildTagOps({ pylumId: 'x' })
  assert.deepEqual(ops['critical asset'], { operation: 'REMOVE' })
})

test('buildProcessTagsBody shapes the entities envelope', () => {
  const body = buildProcessTagsBody('abc123', { department: { operation: 'SET', value: 'IT' } })
  assert.deepEqual(body, { entities: { abc123: { tags: { department: { operation: 'SET', value: 'IT' } }, entityType: 'MACHINE' } } })
})

test('assertTagsApplied passes on success and throws on a genuine failure', () => {
  const okBody = JSON.stringify({ entities: { abc123: { results: { department: { success: true } } } } })
  assert.doesNotThrow(() => assertTagsApplied(okBody, 'abc123'))

  const failBody = JSON.stringify({ entities: { abc123: { results: { department: { success: false, operation: 'SET' } } } } })
  assert.throws(() => assertTagsApplied(failBody, 'abc123'))
})

test('assertTagsApplied tolerates a failed REMOVE of an already-absent tag', () => {
  const body = JSON.stringify({ entities: { abc123: { results: { location: { success: false, operation: 'REMOVE', oldValue: '' } } } } })
  assert.doesNotThrow(() => assertTagsApplied(body, 'abc123'))
})

test('sensorsFromResponse unwraps a bare array and a { sensors } envelope', () => {
  assert.equal(sensorsFromResponse(JSON.stringify([{ pylumId: 'a' }])).length, 1)
  assert.equal(sensorsFromResponse(JSON.stringify({ sensors: [{ pylumId: 'a' }, { pylumId: 'b' }] })).length, 2)
  assert.equal(sensorsFromResponse('not json').length, 0)
})

test('buildPylumIdQuery filters by exact pylumId', () => {
  const q = buildPylumIdQuery('abc123')
  assert.deepEqual(q.filters, [{ fieldName: 'pylumId', operator: 'Equals', values: ['abc123'] }])
})

test('extractTagSnapshot reads the camelCase sensor-row fields and returns null when absent', () => {
  const rows = [{ pylumId: 'abc123', department: 'IT', location: '', deviceType: 'Laptop', criticalAsset: true, customTags: 'exec' }]
  const snap = extractTagSnapshot(rows, 'abc123')
  assert.deepEqual(snap, { department: 'IT', location: null, deviceType: 'Laptop', criticalAsset: true, customTags: 'exec' })
  assert.equal(extractTagSnapshot(rows, 'missing'), null)
})

test('buildTagOpsFromSnapshot restores prior values and removes nulls', () => {
  const ops = buildTagOpsFromSnapshot({ department: 'IT', location: null, criticalAsset: false })
  assert.deepEqual(ops['department'], { operation: 'SET', value: 'IT' })
  assert.deepEqual(ops['location'], { operation: 'REMOVE' })
  assert.deepEqual(ops['critical asset'], { operation: 'SET', value: false })
  assert.deepEqual(ops['custom tags'], { operation: 'REMOVE' })
})

test('buildTagOpsFromSnapshot removes every tag from a null snapshot', () => {
  const ops = buildTagOpsFromSnapshot(null)
  for (const key of ['department', 'location', 'device type', 'critical asset', 'custom tags']) {
    assert.deepEqual(ops[key], { operation: 'REMOVE' })
  }
})
