// healthCheck for cloud-iom-custom-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared rule must still resolve
// through the Cloud Security rules id query, reported as `iom-rule:<name>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  idsPage,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'cloud-iom-custom-rules',
  handler: healthCheck,
  probePath: '/cloud-policies/queries/rules/v1',
  scopePattern: /Cloud Security: Read/,
})

const RULE = item('Public S3 buckets', {
  name: 'block-public-s3',
  description: 'Flags S3 buckets that allow public read access',
  cloudProvider: 'aws',
  resourceType: 'AWS::S3::Bucket',
  severity: 'high',
  logic: 'package veltrix\ndeny { input.public_read }',
})

const LIVE = { id: 'rule-live-1', name: 'block-public-s3' }

test('cloud-iom-custom-rules healthCheck: passes when every declared rule is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['rule-live-1']), entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'iom-rule:block-public-s3')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules healthCheck: fails when a declared rule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'iom-rule:block-public-s3')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every rule would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('iom-rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-rule lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules healthCheck: reports a failed per-rule lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-rule query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'iom-rule:block-public-s3')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
