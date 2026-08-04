import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import {
  activationsFromResponse,
  activationsPath,
  deactivationsPath,
  effectiveVersion,
  isFailed,
  isInFlight,
  latestForNetwork,
  normalizeNetwork,
  readActivationFields,
} from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the EdgeWorkers API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid
 * signer itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.edgeWorkerName ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodItem = { edgeWorkerName: 'my_edgeworker', version: '3', network: 'STAGING' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good activation item', async () => {
  const res = await validate(ctxOf([goodItem]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing EdgeWorker name', async () => {
  const res = await validate(ctxOf([{ ...goodItem, edgeWorkerName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing version', async () => {
  const res = await validate(ctxOf([{ ...goodItem, version: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VERSION'))
})

test('validate rejects an unknown network', async () => {
  const res = await validate(ctxOf([{ ...goodItem, network: 'DEV' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NETWORK'))
})

test('validate warns on a duplicate (edgeWorkerName, network) pair', async () => {
  const res = await validate(ctxOf([goodItem, { ...goodItem }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TARGET'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeNetwork coerces to STAGING/PRODUCTION with STAGING as the default', () => {
  assert.equal(normalizeNetwork('production'), 'PRODUCTION')
  assert.equal(normalizeNetwork('nonsense'), 'STAGING')
})

test('readActivationFields normalizes an item', () => {
  assert.deepEqual(readActivationFields(goodItem), { edgeWorkerName: 'my_edgeworker', network: 'STAGING', version: '3', note: '' })
})

test('activationsFromResponse unwraps the { activations: [...] } envelope', () => {
  assert.deepEqual(activationsFromResponse({ activations: [{ version: '1' }] }), [{ version: '1' }])
  assert.deepEqual(activationsFromResponse(null), [])
})

test('isInFlight / isFailed classify known statuses', () => {
  assert.equal(isInFlight('PENDING'), true)
  assert.equal(isInFlight('IN_PROGRESS'), true)
  assert.equal(isInFlight('COMPLETE'), false)
  assert.equal(isFailed('CANCELLED'), true)
  assert.equal(isFailed('COMPLETE'), false)
})

test('latestForNetwork picks the most recently created activation for that network', () => {
  const activations = [
    { network: 'STAGING', version: '1', createdTime: '2026-01-01T00:00:00Z' },
    { network: 'STAGING', version: '2', createdTime: '2026-02-01T00:00:00Z' },
    { network: 'PRODUCTION', version: '5', createdTime: '2026-03-01T00:00:00Z' },
  ]
  assert.equal(latestForNetwork(activations, 'STAGING')?.version, '2')
  assert.equal(latestForNetwork(activations, 'PRODUCTION')?.version, '5')
  assert.equal(latestForNetwork(activations, 'staging')?.version, '2') // case-insensitive
})

test('effectiveVersion returns null when the latest request is in flight or failed', () => {
  const inFlight = [{ network: 'STAGING', version: '2', status: 'PENDING', createdTime: '2026-01-01' }]
  const failed = [{ network: 'STAGING', version: '2', status: 'FAILED', createdTime: '2026-01-01' }]
  const complete = [{ network: 'STAGING', version: '2', status: 'COMPLETE', createdTime: '2026-01-01' }]
  assert.equal(effectiveVersion(inFlight, 'STAGING'), null)
  assert.equal(effectiveVersion(failed, 'STAGING'), null)
  assert.equal(effectiveVersion(complete, 'STAGING'), '2')
  assert.equal(effectiveVersion([], 'STAGING'), null)
})

test('activationsPath / deactivationsPath shape the endpoints', () => {
  assert.equal(activationsPath(42), '/edgeworkers/v1/ids/42/activations')
  assert.equal(deactivationsPath(42), '/edgeworkers/v1/ids/42/deactivations')
})
