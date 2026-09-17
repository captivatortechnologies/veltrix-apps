// driftDetect for cloud-account-registrations.
//
// The shared contract covers the invariants: drift never writes, a declared
// account the tenant no longer holds is critical drift, and a 500 is never
// reported as the account being gone. This handler words absence as
// `not registered` rather than the catalog's `missing`, which `absentActual`
// carries into both of those assertions.
//
// What is specific here: a registration's identity is a customer's cloud
// account, so the load-bearing test is that a read this handler could not
// perform is reported as unreachable — never as the account having been
// unhooked from Falcon Cloud Security.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  item,
  leaksSecret,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

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

const LABEL = 'aws:123456789012'

registerDriftContract({
  label: 'cloud-account-registrations',
  handler: driftDetect,
  items: [AWS_ACCOUNT],
  absentActual: 'not registered',
})

/** The live registration exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  account_id: '123456789012',
  account_type: 'commercial',
  iam_role_arn: 'arn:aws:iam::123456789012:role/CrowdStrikeCSPMReader',
  cloudtrail_region: 'us-east-1',
  behavior_assessment_enabled: true,
  sensor_management_enabled: true,
  dspm_enabled: false,
  ...over,
})

test('cloud-account-registrations driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, entityPage([live()])])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: reports an unreadable tenant AS unreadable', async () => {
  // The shared contract proves the 500 does not become "not registered". This
  // proves the positive half: the operator is told the account could not be
  // read, rather than that their production cloud account was unhooked from
  // Falcon Cloud Security.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    assert.equal(result.diffs.length, 1)
    assert.equal(result.diffs[0].field, LABEL)
    assert.equal(result.diffs[0].expected, 'reachable')
    assert.match(String(result.diffs[0].actual), /^unreachable:/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: reports a capability switched off in the console as critical', async () => {
  // A capability that should be on but is off leaves the account under-assessed,
  // which is the whole point of registering it.
  const { restore } = recordFetch([TOKEN, entityPage([live({ behavior_assessment_enabled: false })])])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.behaviorAssessmentEnabled`)
    assert.ok(diff, `expected a behaviour-assessment diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: reports the trust role repointed at another role as critical', async () => {
  const { restore } = recordFetch([
    TOKEN,
    entityPage([live({ iam_role_arn: 'arn:aws:iam::123456789012:role/SomebodyElse' })]),
  ])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.iamRoleArn`)
    assert.ok(diff, `expected an IAM role diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'arn:aws:iam::123456789012:role/SomebodyElse')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: reports the cloudtrail region moved', async () => {
  const { restore } = recordFetch([TOKEN, entityPage([live({ cloudtrail_region: 'eu-west-1' })])])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.cloudtrailRegion`)
    assert.ok(diff, `expected a cloudtrail region diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'us-east-1')
    assert.equal(diff.actual, 'eu-west-1')
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: leaves the trust role unmanaged when the canvas declared none', async () => {
  // Falcon's own setup CloudFormation creates the role, so a canvas that has not
  // recorded it yet does not own it and must not report it as drift.
  const withoutRole = item('Production AWS', {
    cloudProvider: 'aws',
    accountType: 'commercial',
    accountId: '123456789012',
    behaviorAssessmentEnabled: true,
    sensorManagementEnabled: true,
  })
  const { restore } = recordFetch([TOKEN, entityPage([live({ cloudtrail_region: 'eu-west-1' })])])
  try {
    const result = await driftDetect(driftContext([withoutRole]))

    assert.equal(
      result.diffs.some((d) => d.field === `${LABEL}.iamRoleArn` || d.field === `${LABEL}.cloudtrailRegion`),
      false,
      `an undeclared role/region must not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: reports an Azure default-subscription flag flipped in the console', async () => {
  const azure = item('Production Azure', {
    cloudProvider: 'azure',
    accountType: 'commercial',
    subscriptionId: '11111111-2222-3333-4444-555555555555',
    tenantId: '99999999-8888-7777-6666-555555555555',
    defaultSubscription: true,
  })
  const { restore } = recordFetch([
    TOKEN,
    entityPage([
      {
        subscription_id: '11111111-2222-3333-4444-555555555555',
        account_type: 'commercial',
        default_subscription: false,
      },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([azure]))

    const diff = result.diffs.find(
      (d) => d.field === 'azure:11111111-2222-3333-4444-555555555555.defaultSubscription',
    )
    assert.ok(diff, `expected a default-subscription diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    entityPage([
      live({
        dspm_enabled: true,
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.dspmEnabled`)
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch([TOKEN, entityPage([live({ dspm_enabled: true, modified_by: CLIENT_ID })])])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT]))

    const diff = result.diffs.find((d) => d.field === `${LABEL}.dspmEnabled`)
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-account-registrations driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Production AWS', {
    cloudProvider: 'aws',
    accountType: 'commercial',
    accountId: '123456789012',
    iamRoleArn: 'arn:aws:iam::123456789012:role/CrowdStrikeCSPMReader',
    regions: 'us-east-1, us-west-2',
    behaviorAssessmentEnabled: true,
    sensorManagementEnabled: true,
    dspmEnabled: true,
  })
  const { restore } = recordFetch([TOKEN, entityPage([live()])])
  try {
    const result = await driftDetect(driftContext([AWS_ACCOUNT], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
