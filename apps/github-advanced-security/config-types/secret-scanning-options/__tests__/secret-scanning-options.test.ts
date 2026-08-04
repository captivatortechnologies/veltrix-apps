import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, parseReviewers, buildSecretScanningOptionsPatch, liveState, parseRepository, normalizeBool } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.repository ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  repository: 'octo-org/octo-repo',
  secret_scanning_validity_checks: true,
  secret_scanning_non_provider_patterns: true,
  secret_scanning_ai_detection: false,
  secret_scanning_delegated_alert_dismissal: false,
  secret_scanning_delegated_bypass: true,
  delegated_bypass_reviewers: '[{"reviewer_id":1,"reviewer_type":"TEAM"}]',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing / malformed repository', async () => {
  const res = await validate(ctxOf([{ ...good, repository: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REPOSITORY'))
  const res2 = await validate(ctxOf([{ ...good, repository: 'bad' }]))
  assert.ok(res2.errors.some((e) => e.code === 'INVALID_REPOSITORY'))
})

test('validate accepts a good configuration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate repository', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_REPOSITORY'))
})

test('validate rejects malformed reviewers JSON', async () => {
  const res = await validate(ctxOf([{ ...good, delegated_bypass_reviewers: '[bad' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REVIEWERS_JSON'))
})

test('validate warns when delegated bypass has no reviewers', async () => {
  const res = await validate(ctxOf([{ ...good, delegated_bypass_reviewers: '' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DELEGATED_BYPASS_WITHOUT_REVIEWERS'))
})

// --- _shared ----------------------------------------------------------------

test('parseRepository / normalizeBool behave as expected', () => {
  assert.deepEqual(parseRepository('a/b'), { owner: 'a', repo: 'b' })
  assert.equal(parseRepository('bad'), null)
  assert.equal(normalizeBool('enabled'), true)
  assert.equal(normalizeBool(''), false)
})

test('parseReviewers: blank -> [], invalid -> error, array -> value', () => {
  assert.deepEqual(parseReviewers('').value, [])
  assert.ok(parseReviewers('{not json').error)
  assert.ok(parseReviewers('{"a":1}').error)
  assert.deepEqual(parseReviewers('[{"reviewer_id":1,"reviewer_type":"TEAM"}]').value, [{ reviewer_id: 1, reviewer_type: 'TEAM' }])
})

test('buildSecretScanningOptionsPatch sets the five sub-keys and reviewers when bypass enabled', () => {
  const { body, errors } = buildSecretScanningOptionsPatch(desiredFromItem(good))
  assert.equal(errors.length, 0)
  assert.equal(body.security_and_analysis.secret_scanning_validity_checks?.status, 'enabled')
  assert.equal(body.security_and_analysis.secret_scanning_ai_detection?.status, 'disabled')
  assert.deepEqual(body.security_and_analysis.secret_scanning_delegated_bypass_options?.reviewers, [{ reviewer_id: 1, reviewer_type: 'TEAM' }])
})

test('buildSecretScanningOptionsPatch omits bypass_options when bypass disabled', () => {
  const { body } = buildSecretScanningOptionsPatch(desiredFromItem({ ...good, secret_scanning_delegated_bypass: false }))
  assert.equal(body.security_and_analysis.secret_scanning_delegated_bypass_options, undefined)
})

test('liveState reads enabled/disabled status slots', () => {
  const state = liveState({
    secret_scanning_validity_checks: { status: 'enabled' },
    secret_scanning_non_provider_patterns: { status: 'disabled' },
  })
  assert.equal(state.validityChecks, true)
  assert.equal(state.nonProviderPatterns, false)
  assert.equal(state.aiDetection, false)
})
