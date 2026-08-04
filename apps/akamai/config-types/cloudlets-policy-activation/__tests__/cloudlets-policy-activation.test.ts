import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { effectiveVersion, isPending, normalizeNetwork, policyActivationsPath, readActivationFields } from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Cloudlets API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid
 * signer itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.policyName ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodItem = { policyName: 'block_bad_bots', policyVersion: 2, network: 'STAGING' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good activation item', async () => {
  const res = await validate(ctxOf([goodItem]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing policy name', async () => {
  const res = await validate(ctxOf([{ ...goodItem, policyName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_POLICY_NAME'))
})

test('validate rejects a non-positive version', async () => {
  const res = await validate(ctxOf([{ ...goodItem, policyVersion: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VERSION'))
})

test('validate rejects an unknown network', async () => {
  const res = await validate(ctxOf([{ ...goodItem, network: 'DEV' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NETWORK'))
})

test('validate warns on a duplicate (policyName, network) pair', async () => {
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
  assert.equal(normalizeNetwork('STAGING'), 'STAGING')
  assert.equal(normalizeNetwork('nonsense'), 'STAGING')
})

test('readActivationFields normalizes an item', () => {
  const f = readActivationFields(goodItem)
  assert.deepEqual(f, { policyName: 'block_bad_bots', policyVersion: 2, network: 'STAGING' })
})

test('effectiveVersion reads the network-specific effective policyVersion', () => {
  const policy = { currentActivations: { staging: { effective: { policyVersion: 5 } }, production: { effective: null } } }
  assert.equal(effectiveVersion(policy, 'STAGING'), 5)
  assert.equal(effectiveVersion(policy, 'PRODUCTION'), null)
})

test('isPending reads the network-specific latest.status', () => {
  const policy = { currentActivations: { staging: { latest: { status: 'IN_PROGRESS' } }, production: { latest: { status: 'SUCCESS' } } } }
  assert.equal(isPending(policy, 'STAGING'), true)
  assert.equal(isPending(policy, 'PRODUCTION'), false)
})

test('policyActivationsPath shapes the endpoint', () => {
  assert.equal(policyActivationsPath(42), '/cloudlets/v3/policies/42/activations')
})
