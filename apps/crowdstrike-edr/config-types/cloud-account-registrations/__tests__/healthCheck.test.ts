// healthCheck for cloud-account-registrations.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. The probe here is a
// BARE GET on the AWS CSPM account collection (no `limit`), which proves
// reachability and the registration read scope whichever providers the canvas
// declares. What is specific below is the second half: every declared account
// must still resolve under its own provider identity, reported as
// `account:<provider>:<id>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  item,
  notFound,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'cloud-account-registrations',
  handler: healthCheck,
  probePath: '/cloud-connect-cspm-aws/entities/account/v1',
  scopePattern: /CSPM registration: Read/,
})

const AWS_ACCOUNT = item('Production AWS', {
  cloudProvider: 'aws',
  accountType: 'commercial',
  accountId: '123456789012',
  iamRoleArn: 'arn:aws:iam::123456789012:role/CrowdStrikeCSPMReader',
})

const LIVE_AWS = { account_id: '123456789012', account_type: 'commercial', status: 'provisioned' }

test('cloud-account-registrations healthCheck: passes when every declared account is registered', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE_AWS])])
  try {
    const result = await healthCheck(healthContext([AWS_ACCOUNT]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'account:aws:123456789012')
    assert.ok(check, `expected a per-account check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-account-registrations healthCheck: fails when a declared account has been deregistered', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([AWS_ACCOUNT]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'account:aws:123456789012')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is not registered in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-account-registrations healthCheck: a 404 on the lookup is a known answer, not an error', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, notFound()])
  try {
    const result = await healthCheck(healthContext([AWS_ACCOUNT]))

    const check = result.checks.find((c) => c.name === 'account:aws:123456789012')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is not registered in the tenant/)
  } finally {
    restore()
  }
})

test('cloud-account-registrations healthCheck: does not look for accounts when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every account would read as "not registered" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([AWS_ACCOUNT]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('account:')),
      false,
      'an unreadable tenant must not be reported as the account being deregistered',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('ids=')).length,
      0,
      'no per-account lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('cloud-account-registrations healthCheck: reports a failed per-account lookup as failed, not as deregistered', async () => {
  // The reachability probe succeeds and the per-account read then 500s. That is
  // "I could not look", and an operator must not be told their production
  // account was removed from Falcon.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([AWS_ACCOUNT]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'account:aws:123456789012')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /Failed to look up/)
    assert.equal(
      /is not registered in the tenant/.test(String(check.message)),
      false,
      'a 500 became "not registered"',
    )
  } finally {
    restore()
  }
})

test('cloud-account-registrations healthCheck: does not accept a neighbouring account as the declared one', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([{ account_id: '999999999999' }])])
  try {
    const result = await healthCheck(healthContext([AWS_ACCOUNT]))

    const check = result.checks.find((c) => c.name === 'account:aws:123456789012')
    assert.ok(check)
    assert.equal(check.passed, false, 'another account in the same CID is not the declared registration')
  } finally {
    restore()
  }
})
