// deploy for cloud-account-registrations.
//
// This config type does not go through lib/entityAdapter: a registration is
// addressed by the customer's own cloud account identity (AWS account id, Azure
// subscription id, GCP project id) against a PER-PROVIDER legacy CSPM endpoint,
// and the write body is `{ resources: [ … ] }`. So the assertions that matter
// here are about identity: the right provider endpoint, the declared identity
// and nothing else, and an unreadable tenant never becoming "not registered yet"
// (which would re-register an account that is already onboarded).

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CLIENT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  serverError,
  vendorCalls,
  writeCalls,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const AWS = /\/cloud-connect-cspm-aws\/entities\/account\/v1/
const AZURE = /\/cloud-connect-cspm-azure\/entities\/account\/v1/
const GCP = /\/cloud-connect-cspm-gcp\/entities\/account\/v1/

/**
 * One declared AWS registration. `extractAccountSpecs` reads a FLAT `fields`
 * record — `cloudProvider`, `accountType`, `accountId`, `iamRoleArn`, `regions`
 * and the capability flags.
 */
const AWS_ACCOUNT = item('Production AWS', {
  cloudProvider: 'aws',
  accountType: 'commercial',
  accountId: '123456789012',
  iamRoleArn: 'arn:aws:iam::123456789012:role/CrowdStrikeCSPMReader',
  regions: 'us-east-1, us-west-2',
  behaviorAssessmentEnabled: true,
  sensorManagementEnabled: true,
  dspmEnabled: false,
})

const AZURE_ACCOUNT = item('Production Azure', {
  cloudProvider: 'azure',
  accountType: 'commercial',
  subscriptionId: '11111111-2222-3333-4444-555555555555',
  tenantId: '99999999-8888-7777-6666-555555555555',
  defaultSubscription: true,
  behaviorAssessmentEnabled: true,
})

const GCP_ACCOUNT = item('Production GCP', {
  cloudProvider: 'gcp',
  accountType: 'commercial',
  projectId: 'acme-prod-platform',
  dspmEnabled: true,
})

/**
 * The AWS registration as it exists in the tenant BEFORE this deploy —
 * deliberately different from the canvas in EVERY managed field, so a rollback
 * record that captured the DESIRED values instead of the LIVE ones fails here.
 */
const LIVE_AWS = {
  account_id: '123456789012',
  account_type: 'gov',
  iam_role_arn: 'arn:aws:iam::123456789012:role/LegacyReadOnly',
  cloudtrail_region: 'eu-west-1',
  behavior_assessment_enabled: false,
  sensor_management_enabled: false,
  dspm_enabled: true,
}

registerDeployGuardContract({
  label: 'cloud-account-registrations',
  handler: deploy,
  items: [AWS_ACCOUNT],
})

/** The single account resource inside a `{ resources: [ … ] }` write body. */
function resourceOf(call: RecordedCall | undefined): Record<string, unknown> | null {
  const resources = bodyOf(call)?.resources
  return Array.isArray(resources) ? ((resources[0] ?? null) as Record<string, unknown> | null) : null
}

test('cloud-account-registrations deploy: registers an AWS account that is not yet registered', async () => {
  const { calls, restore } = routeFetch([{ url: AWS, respond: EMPTY }])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one registration, got ${describeCalls(posts)}`)
    assert.match(posts[0].url, AWS, 'an AWS account must be registered on the AWS endpoint')

    const body = resourceOf(posts[0])
    assert.equal(body?.account_id, '123456789012')
    assert.equal(body?.account_type, 'commercial')
    assert.equal(body?.iam_role_arn, 'arn:aws:iam::123456789012:role/CrowdStrikeCSPMReader')
    assert.equal(body?.cloudtrail_region, 'us-east-1', 'the first declared region is the cloudtrail region')
    assert.equal(body?.behavior_assessment_enabled, true)
    assert.equal(body?.sensor_management_enabled, true)
    assert.equal(body?.dspm_enabled, false)
    // CSPM is the base registration, not a toggle — sending it would be rejected.
    assert.equal(Object.prototype.hasOwnProperty.call(body ?? {}, 'cspm_enabled'), false)

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'an unregistered account must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: registers each account on its own provider endpoint', async () => {
  // Every non-token call answers with an empty envelope: the lookups read as
  // "not registered" and the registrations succeed, so what is left to assert is
  // purely which endpoint each identity was written to.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT, AZURE_ACCOUNT, GCP_ACCOUNT]))

    assert.equal(result.success, true)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 3, `expected three registrations, got ${describeCalls(posts)}`)

    const aws = posts.find((c) => AWS.test(c.url))
    const azure = posts.find((c) => AZURE.test(c.url))
    const gcp = posts.find((c) => GCP.test(c.url))
    assert.ok(aws && azure && gcp, `providers were not dispatched separately: ${describeCalls(posts)}`)

    assert.equal(resourceOf(aws)?.account_id, '123456789012')
    assert.equal(resourceOf(azure)?.subscription_id, '11111111-2222-3333-4444-555555555555')
    assert.equal(resourceOf(azure)?.tenant_id, '99999999-8888-7777-6666-555555555555')
    assert.equal(resourceOf(gcp)?.parent_id, 'acme-prod-platform')
    assert.equal(resourceOf(gcp)?.parent_type, 'project')
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: never registers under an identity the canvas did not declare', async () => {
  // The lookup answers with a NEIGHBOURING account — the same collection, a
  // different customer account. Adopting it would patch somebody else's
  // registration; the handler must pin the declared identity and create.
  const { calls, restore } = routeFetch([
    { url: AWS, method: 'GET', respond: entityPage([{ ...LIVE_AWS, account_id: '999999999999' }]) },
    { url: AWS, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a foreign account must never be patched')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1)
    assert.equal(resourceOf(posts[0])?.account_id, '123456789012')

    for (const call of vendorCalls(calls)) {
      assert.equal(
        call.url.includes('999999999999'),
        false,
        `an undeclared account identity reached the tenant: ${call.method} ${call.url}`,
      )
    }
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: records the registration it created so rollback can deregister it', async () => {
  const { restore } = routeFetch([{ url: AWS, respond: EMPTY }])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].cloudProvider, 'aws')
    assert.equal(state[0].identity, '123456789012')
    assert.equal(state[0].existed, false, 'an account this deploy registered is not pre-existing')
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: updates an account already registered, carrying its identity', async () => {
  const { calls, restore } = routeFetch([
    { url: AWS, method: 'GET', respond: entityPage([LIVE_AWS]) },
    { url: AWS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'a registered account must not be registered again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = resourceOf(patches[0])
    assert.equal(body?.account_id, '123456789012', 'the update must address the live account by its id')
    assert.equal(body?.iam_role_arn, 'arn:aws:iam::123456789012:role/CrowdStrikeCSPMReader')
    assert.equal(body?.cloudtrail_region, 'us-east-1')
    assert.equal(body?.behavior_assessment_enabled, true)
    assert.equal(body?.dspm_enabled, false)
    // account_type is immutable, so converging it would be rejected by Falcon.
    assert.equal(Object.prototype.hasOwnProperty.call(body ?? {}, 'account_type'), false)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: records the LIVE prior values of an account it overwrote', async () => {
  // The canvas asks for commercial / CrowdStrikeCSPMReader / us-east-1 / on-on-off;
  // the tenant holds gov / LegacyReadOnly / eu-west-1 / off-off-on. Rollback
  // restores what was there, so every one of these must come from LIVE_AWS.
  const { restore } = routeFetch([
    { url: AWS, method: 'GET', respond: entityPage([LIVE_AWS]) },
    { url: AWS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.account_type, 'gov')
    assert.equal(prior.iam_role_arn, 'arn:aws:iam::123456789012:role/LegacyReadOnly')
    assert.equal(prior.cloudtrail_region, 'eu-west-1')
    assert.equal(prior.behavior_assessment_enabled, false)
    assert.equal(prior.sensor_management_enabled, false)
    assert.equal(prior.dspm_enabled, true)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: an unreadable tenant fails the deploy instead of re-registering', async () => {
  // A 500 on the lookup is "I could not tell whether this account is already
  // onboarded". Treating it as "not registered" would POST a duplicate
  // registration over a live one.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
    assert.match(String(result.message), /Failed to look up/)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: AWS, method: 'GET', respond: EMPTY },
    { url: AWS, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an account it never registered as onboarded.
  const { restore } = routeFetch([
    { url: AWS, method: 'GET', respond: EMPTY },
    { url: AWS, method: 'POST', respond: partialFailure('account is already registered to another CID') },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a registration')
    assert.match(String(result.message), /another CID/)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: keeps the rollback record of what it wrote when a later account fails', async () => {
  // The first account is registered, the second is rejected. Everything the
  // deploy already changed must still come back on the failure path — a `catch`
  // that returns only `{ success: false, message }` discards it.
  const SECOND = item('Sandbox AWS', {
    cloudProvider: 'aws',
    accountType: 'commercial',
    accountId: '210987654321',
  })
  const { restore } = routeFetch([
    { url: AWS, method: 'GET', respond: EMPTY },
    { url: AWS, method: 'POST', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the account that WAS registered must still be recorded')
    assert.equal(state[0].identity, '123456789012')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: AWS, method: 'GET', respond: entityPage([LIVE_AWS]) },
    { url: AWS, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([AWS_ACCOUNT]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
    assert.equal(
      JSON.stringify(result).includes(CLIENT_ID),
      false,
      'the API client id must not travel in the result either',
    )
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: skips an account whose provider has no endpoint, without calling Falcon', async () => {
  // An unsupported provider must not be dispatched to a guessed URL.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(
      deployContext([item('Oracle estate', { cloudProvider: 'oracle', accountId: '123456789012' })]),
    )

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'an unsupported provider means no request at all')
  } finally {
    restore()
  }
})

test('cloud-account-registrations deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
