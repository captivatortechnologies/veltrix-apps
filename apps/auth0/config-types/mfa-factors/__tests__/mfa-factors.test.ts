import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { arrayToPolicy, indexFactors, policyToArray, readFactorFields, type Auth0GuardianFactor } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  policy: 'all-applications',
  factor_sms: true,
  factor_otp: true,
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts each known policy value', async () => {
  for (const policy of ['never', 'all-applications', 'confidence-score']) {
    const res = await validate(ctxOf([{ ...good, policy }]))
    assert.equal(res.valid, true, `expected "${policy}" to be valid`)
  }
})

test('validate rejects an unknown policy value', async () => {
  const res = await validate(ctxOf([{ ...good, policy: 'sometimes' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_POLICY'))
})

test('validate rejects more than one declared item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'singleton'))
})

// --- _shared helpers ---------------------------------------------------------

test('policyToArray maps never to an empty array and everything else to a one-item array', () => {
  assert.deepEqual(policyToArray('never'), [])
  assert.deepEqual(policyToArray('all-applications'), ['all-applications'])
  assert.deepEqual(policyToArray('confidence-score'), ['confidence-score'])
})

test('arrayToPolicy is the inverse of policyToArray', () => {
  assert.equal(arrayToPolicy([]), 'never')
  assert.equal(arrayToPolicy(undefined), 'never')
  assert.equal(arrayToPolicy(['all-applications']), 'all-applications')
  assert.equal(arrayToPolicy(['confidence-score']), 'confidence-score')
})

test('readFactorFields maps every canvas checkbox to its Auth0 factor name', () => {
  const factors = readFactorFields({ factor_sms: true, factor_otp: 'true', factor_email: false })
  assert.equal(factors.sms, true)
  assert.equal(factors.otp, true)
  assert.equal(factors.email, false)
  assert.equal(factors['push-notification'], false)
  assert.equal(Object.keys(factors).length, 8)
})

test('indexFactors builds a name → enabled map from the live factors list', () => {
  const live: Auth0GuardianFactor[] = [
    { name: 'sms', enabled: true },
    { name: 'otp', enabled: false },
  ]
  assert.deepEqual(indexFactors(live), { sms: true, otp: false })
})
