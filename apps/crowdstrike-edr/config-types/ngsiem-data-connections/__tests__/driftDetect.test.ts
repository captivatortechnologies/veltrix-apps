// driftDetect for ngsiem-data-connections.
//
// The shared contract covers the invariants: drift never writes, a deleted
// connection is critical drift, and a 500 is never reported as the connection
// being gone. What is specific here is the case this check exists for: a DATA
// FORWARDER repointed at a different repository, or switched off, keeps
// reporting as deployed while the events stop arriving. Those must produce a
// diff, not an empty "in sync".
//
// The upstream-secret leak check below is LOCAL to this file: the shared
// `leaksSecret` only knows the Falcon token and API client secret.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const UPSTREAM_SECRET = 'aws-upstream-access-key-MUST-NOT-LEAK'

function leaksUpstreamSecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(UPSTREAM_SECRET)
}

const CONNECTION = item('CloudTrail ingest', {
  name: 'acme-cloudtrail',
  connectorType: 'aws-s3',
  sourceEndpoint: 's3://acme-cloudtrail-logs',
  credential: UPSTREAM_SECRET,
  targetRepository: 'acme-security-events',
  parser: 'aws-cloudtrail',
  enabled: true,
})

registerDriftContract({
  label: 'ngsiem-data-connections',
  handler: driftDetect,
  items: [CONNECTION],
})

/** The live connection exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'conn-live-1',
  name: 'acme-cloudtrail',
  connector_type: 'aws-s3',
  parser: 'aws-cloudtrail',
  status: 'enabled',
  config: { endpoint: 's3://acme-cloudtrail-logs', repository: 'acme-security-events' },
  ...over,
})

/** This type reads the whole collection in one call rather than per-object. */
function listing(connections: Array<Record<string, unknown>>) {
  return [TOKEN, entityPage(connections)]
}

test('ngsiem-data-connections driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(listing([live()]))
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: reports a forwarder repointed at a different repository', async () => {
  // This is the case drift detection exists to catch: the connection still
  // reports as deployed while its events land somewhere else entirely.
  const { restore } = recordFetch(
    listing([live({ config: { endpoint: 's3://acme-cloudtrail-logs', repository: 'someone-elses-repo' } })]),
  )
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'acme-cloudtrail.targetRepository')
    assert.ok(diff, `entered the drift branch and emitted no diff: ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'acme-security-events')
    assert.equal(diff.actual, 'someone-elses-repo')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: reads the repository from a top-level field too', async () => {
  // The live shape is not fully documented, so `repository` is accepted at the
  // top level as well as inside `config`.
  const { restore } = recordFetch(
    listing([live({ repository: 'someone-elses-repo', config: { endpoint: 's3://acme-cloudtrail-logs' } })]),
  )
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    const diff = result.diffs.find((d) => d.field === 'acme-cloudtrail.targetRepository')
    assert.ok(diff, `top-level repository was not read: ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'someone-elses-repo')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: reports a forwarder disabled in the console', async () => {
  // A disabled connection ingests nothing, and looks identical from the outside.
  const { restore } = recordFetch(listing([live({ status: 'disabled' })]))
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'acme-cloudtrail.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'enabled')
    assert.equal(diff.actual, 'disabled')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: reports a connector type or parser changed in the console', async () => {
  const { restore } = recordFetch(
    listing([live({ connector_type: 'azure-eventhub', parser: 'some-other-parser' })]),
  )
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    const connector = result.diffs.find((d) => d.field === 'acme-cloudtrail.connectorType')
    assert.ok(connector, `expected a connectorType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(connector.actual, 'azure-eventhub')

    const parser = result.diffs.find((d) => d.field === 'acme-cloudtrail.parser')
    assert.ok(parser)
    assert.equal(parser.actual, 'some-other-parser')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: leaves the parser unmanaged when the canvas declares none', async () => {
  // A blank parser accepts the connector default, so an assigned default is not
  // this configuration's drift to report.
  const noParser = item('CloudTrail ingest', {
    name: 'acme-cloudtrail',
    connectorType: 'aws-s3',
    credential: UPSTREAM_SECRET,
    targetRepository: 'acme-security-events',
  })
  const { restore } = recordFetch(listing([live({ parser: 'connector-default-parser' })]))
  try {
    const result = await driftDetect(driftContext([noParser]))

    assert.equal(
      result.diffs.some((d) => d.field === 'acme-cloudtrail.parser'),
      false,
      'an undeclared parser must not drift',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: never puts the upstream credential in a diff', async () => {
  // The live entity can echo a secret-adjacent config; nothing the handler emits
  // may carry it, and the source endpoint is deliberately not diffed either.
  const { restore } = recordFetch(
    listing([
      live({
        status: 'disabled',
        config: {
          endpoint: 's3://acme-cloudtrail-logs',
          repository: 'someone-elses-repo',
          credential: UPSTREAM_SECRET,
        },
      }),
    ]),
  )
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    assert.equal(result.hasDrift, true)
    assert.equal(leaksUpstreamSecret(result), false, 'a diff carried the upstream cloud credential')
    assert.equal(
      result.diffs.some((d) => d.field === 'acme-cloudtrail.sourceEndpoint'),
      false,
      'the source endpoint can carry auth params and is not diffed',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    listing([
      live({
        status: 'disabled',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ]),
  )
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    const diff = result.diffs.find((d) => d.field === 'acme-cloudtrail.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(listing([live({ status: 'disabled', modified_by: CLIENT_ID })]))
  try {
    const result = await driftDetect(driftContext([CONNECTION]))

    const diff = result.diffs.find((d) => d.field === 'acme-cloudtrail.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('CloudTrail ingest', {
    ...(CONNECTION.fields as Record<string, unknown>),
    targetRepository: 'a-repository-not-yet-deployed',
    enabled: false,
  })
  const { restore } = recordFetch(listing([live()]))
  try {
    const result = await driftDetect(driftContext([CONNECTION], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
