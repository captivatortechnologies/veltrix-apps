import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyWithOptimisticRetry,
  deploymentIdFromResponse,
  detectionPolicyBundleFromResponse,
  remediationPoliciesBundleFromResponse,
  stateVersionFromResponse,
  validationErrorsFromResponse,
  type SemgrepResponse,
} from '../semgrepApi'

function res(status: number, json: unknown): SemgrepResponse {
  return { status, ok: status >= 200 && status < 300, body: JSON.stringify(json), json }
}

// --- deploymentIdFromResponse ---------------------------------------------------

test('deploymentIdFromResponse matches the deployment with the given slug', () => {
  const r = res(200, { deployments: [{ id: 1, slug: 'a' }, { id: 2, slug: 'b' }] })
  assert.equal(deploymentIdFromResponse(r, 'b'), 2)
})

test('deploymentIdFromResponse falls back to the sole entry when slug is unset', () => {
  const r = res(200, { deployments: [{ id: 42, slug: 'only-one' }] })
  assert.equal(deploymentIdFromResponse(r, null), 42)
})

test('deploymentIdFromResponse falls back to the first entry when the slug does not match', () => {
  const r = res(200, { deployments: [{ id: 1, slug: 'a' }, { id: 2, slug: 'b' }] })
  assert.equal(deploymentIdFromResponse(r, 'nonexistent'), 1)
})

test('deploymentIdFromResponse returns null when there are no deployments', () => {
  assert.equal(deploymentIdFromResponse(res(200, { deployments: [] }), null), null)
  assert.equal(deploymentIdFromResponse(res(200, {}), null), null)
})

// --- stateVersionFromResponse ---------------------------------------------------

test('stateVersionFromResponse reads a non-empty string state_version', () => {
  assert.equal(stateVersionFromResponse(res(200, { state_version: 'abc123' })), 'abc123')
})

test('stateVersionFromResponse returns null when missing or empty', () => {
  assert.equal(stateVersionFromResponse(res(200, {})), null)
  assert.equal(stateVersionFromResponse(res(200, { state_version: '' })), null)
  assert.equal(stateVersionFromResponse(res(200, { state_version: 7 })), null)
})

// --- detectionPolicyBundleFromResponse / remediationPoliciesBundleFromResponse -

test('detectionPolicyBundleFromResponse extracts the bundle', () => {
  const bundle = { product: 'code', rulesets: ['p/owasp-top-10'] }
  assert.deepEqual(detectionPolicyBundleFromResponse(res(200, { bundle })), bundle)
  assert.equal(detectionPolicyBundleFromResponse(res(200, {})), null)
})

test('remediationPoliciesBundleFromResponse extracts the bundle', () => {
  const bundle = { policies: [{ slug: 's', name: 'n' }] }
  assert.deepEqual(remediationPoliciesBundleFromResponse(res(200, { bundle })), bundle)
  assert.equal(remediationPoliciesBundleFromResponse(res(200, {})), null)
})

// --- validationErrorsFromResponse -----------------------------------------------

test('validationErrorsFromResponse extracts validation_errors', () => {
  const errors = [{ code: 'UNKNOWN_REFERENCE', message: 'bad rule' }]
  assert.deepEqual(validationErrorsFromResponse(res(200, { validation_errors: errors })), errors)
})

test('validationErrorsFromResponse defaults to an empty array', () => {
  assert.deepEqual(validationErrorsFromResponse(res(200, {})), [])
})

// --- applyWithOptimisticRetry ----------------------------------------------------

test('applyWithOptimisticRetry returns the first response when it is not 409/428', async () => {
  const attempts: string[] = []
  const result = await applyWithOptimisticRetry(
    async (ifMatch) => {
      attempts.push(ifMatch)
      return res(200, { ok: true })
    },
    async () => 'unused',
    'v1',
  )
  assert.equal(result.status, 200)
  assert.deepEqual(attempts, ['v1'])
})

test('applyWithOptimisticRetry retries exactly once on 409 with a fresh version', async () => {
  const attempts: string[] = []
  const result = await applyWithOptimisticRetry(
    async (ifMatch) => {
      attempts.push(ifMatch)
      return ifMatch === 'v1' ? res(409, { state_version: 'v2' }) : res(200, { ok: true })
    },
    async () => 'v2',
    'v1',
  )
  assert.equal(result.status, 200)
  assert.deepEqual(attempts, ['v1', 'v2'])
})

test('applyWithOptimisticRetry never loops more than once — a persistent 409 surfaces as-is', async () => {
  const attempts: string[] = []
  const result = await applyWithOptimisticRetry(
    async (ifMatch) => {
      attempts.push(ifMatch)
      return res(409, { state_version: 'v2' })
    },
    async () => 'v2',
    'v1',
  )
  assert.equal(result.status, 409)
  assert.deepEqual(attempts, ['v1', 'v2'])
})

test('applyWithOptimisticRetry returns the first response when a fresh version cannot be read', async () => {
  const result = await applyWithOptimisticRetry(
    async () => res(409, {}),
    async () => null,
    'v1',
  )
  assert.equal(result.status, 409)
})
