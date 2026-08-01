import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  parseRepository,
  normalizeBool,
  desiredFromItem,
  buildSecurityAndAnalysisPatch,
  securityAndAnalysisState,
  buildDefaultSetupPatch,
  defaultSetupEnabled,
} from '../_shared'

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
  advanced_security: true,
  secret_scanning: true,
  secret_scanning_push_protection: true,
  dependabot_security_updates: true,
  code_scanning_default_setup: true,
  comment: 'Baseline security posture',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing repository', async () => {
  const res = await validate(ctxOf([{ ...good, repository: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REPOSITORY'))
})

test('validate rejects a malformed repository', async () => {
  const res = await validate(ctxOf([{ ...good, repository: 'not-a-full-name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REPOSITORY'))
})

test('validate warns on a duplicate repository', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_REPOSITORY'))
})

test('validate warns when push protection has no secret scanning', async () => {
  const res = await validate(ctxOf([{ ...good, secret_scanning: false, secret_scanning_push_protection: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PUSH_PROTECTION_WITHOUT_SECRET_SCANNING'))
})

test('validate warns when a feature is on without advanced security', async () => {
  const res = await validate(ctxOf([{ ...good, advanced_security: false, code_scanning_default_setup: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'FEATURE_WITHOUT_ADVANCED_SECURITY'))
})

test('validate accepts a good repository item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('parseRepository splits owner/repo and rejects bad input', () => {
  assert.deepEqual(parseRepository('octo-org/octo-repo'), { owner: 'octo-org', repo: 'octo-repo' })
  assert.deepEqual(parseRepository('  octo-org/octo-repo  '), { owner: 'octo-org', repo: 'octo-repo' })
  assert.equal(parseRepository('no-slash'), null)
  assert.equal(parseRepository('a/b/c'), null)
  assert.equal(parseRepository(''), null)
})

test('normalizeBool coerces canvas values', () => {
  for (const truthy of [true, 'true', 'enabled', '1', 'yes', 'on']) assert.equal(normalizeBool(truthy), true)
  for (const falsy of [false, 'false', 'disabled', '0', '', undefined, null]) assert.equal(normalizeBool(falsy), false)
})

test('buildSecurityAndAnalysisPatch maps booleans to enabled/disabled status', () => {
  const patch = buildSecurityAndAnalysisPatch({
    advanced_security: true,
    secret_scanning: false,
    secret_scanning_push_protection: true,
  })
  assert.deepEqual(patch, {
    security_and_analysis: {
      advanced_security: { status: 'enabled' },
      secret_scanning: { status: 'disabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  })
})

test('securityAndAnalysisState reads the enabled statuses back', () => {
  const state = securityAndAnalysisState({
    advanced_security: { status: 'enabled' },
    secret_scanning: { status: 'disabled' },
  })
  assert.deepEqual(state, { advanced_security: true, secret_scanning: false, secret_scanning_push_protection: false })
})

test('code-scanning default-setup patch + read round-trip', () => {
  assert.deepEqual(buildDefaultSetupPatch(true), { state: 'configured' })
  assert.deepEqual(buildDefaultSetupPatch(false), { state: 'not-configured' })
  assert.equal(defaultSetupEnabled({ state: 'configured' }), true)
  assert.equal(defaultSetupEnabled({ state: 'not-configured' }), false)
  assert.equal(defaultSetupEnabled(null), false)
})

test('desiredFromItem reads all five features + identity', () => {
  const desired = desiredFromItem(good)
  assert.equal(desired.repository, 'octo-org/octo-repo')
  assert.equal(desired.advanced_security, true)
  assert.equal(desired.code_scanning_default_setup, true)
})
