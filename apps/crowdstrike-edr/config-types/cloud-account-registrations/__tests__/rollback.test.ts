// rollback for cloud-account-registrations.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that rollback DEREGISTERS a cloud account — the most
// destructive operation in this app — so the assertions below are mostly about
// the entries that must produce NO call at all, and about the deregistration
// addressing exactly the identity deploy recorded.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  forbidden,
  leaksSecret,
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const AWS = /\/cloud-connect-cspm-aws\/entities\/account\/v1/
const AZURE = /\/cloud-connect-cspm-azure\/entities\/account\/v1/

const CREATED_ENTRY = { cloudProvider: 'aws', identity: '123456789012', existed: false }

const UPDATED_ENTRY = {
  cloudProvider: 'aws',
  identity: '123456789012',
  existed: true,
  prior: {
    account_type: 'gov',
    iam_role_arn: 'arn:aws:iam::123456789012:role/LegacyReadOnly',
    cloudtrail_region: 'eu-west-1',
    behavior_assessment_enabled: false,
    sensor_management_enabled: false,
    dspm_enabled: true,
  },
}

registerRollbackGuardContract({
  label: 'cloud-account-registrations',
  handler: rollback,
  entry: CREATED_ENTRY,
})

/** The single account resource inside a `{ resources: [ … ] }` write body. */
function resourceOf(call: RecordedCall | undefined): Record<string, unknown> | null {
  const resources = bodyOf(call)?.resources
  return Array.isArray(resources) ? ((resources[0] ?? null) as Record<string, unknown> | null) : null
}

test('cloud-account-registrations rollback: deregisters an account this deploy registered', async () => {
  const { calls, restore } = routeFetch([{ url: AWS, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one deregistration, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, AWS, 'an AWS account is deregistered on the AWS endpoint')
    assert.match(deletes[0].url, /ids=123456789012/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created registration is deleted, not patched')
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: treats a 404 on deregistration as already gone', async () => {
  const { restore } = routeFetch([{ url: AWS, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, 'an account already removed is the desired end state')
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: restores the recorded prior values of an account it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: AWS, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = resourceOf(patches[0])
    assert.equal(body?.account_id, '123456789012', 'the restore must address the account by its identity')
    assert.equal(body?.iam_role_arn, 'arn:aws:iam::123456789012:role/LegacyReadOnly')
    assert.equal(body?.cloudtrail_region, 'eu-west-1')
    assert.equal(body?.behavior_assessment_enabled, false)
    assert.equal(body?.sensor_management_enabled, false)
    assert.equal(body?.dspm_enabled, true)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'an account that existed before the deploy must never be deregistered',
    )
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live registration but recorded no prior body. Patching an
  // invented default here is strictly worse than leaving the account alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ cloudProvider: 'aws', identity: '123456789012', existed: true }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: writes nothing for an entry whose provider has no endpoint', async () => {
  // A recording the handler cannot dispatch must be skipped, never guessed at.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ cloudProvider: 'oracle', identity: '123456789012', existed: false }] }),
    )

    assert.equal(calls.length, 0, 'an unsupported provider means no request at all')
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: deregisters on the provider endpoint the entry recorded', async () => {
  const azureEntry = {
    cloudProvider: 'azure',
    identity: '11111111-2222-3333-4444-555555555555',
    existed: false,
  }
  const { calls, restore } = routeFetch([{ url: AZURE, method: 'DELETE', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [azureEntry] }))

    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1)
    assert.match(deletes[0].url, AZURE)
    assert.match(deletes[0].url, /ids=11111111-2222-3333-4444-555555555555/)
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: reports a rejected deregistration rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: AWS, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: AWS, method: 'PATCH', respond: partialFailure('registration is read-only while onboarding') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored account')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-account-registrations rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: AWS, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, identity: '210987654321' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
