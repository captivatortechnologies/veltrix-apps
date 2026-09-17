// driftDetect for ngsiem-parsers.
//
// The shared contract covers the invariants: drift never writes, a deleted
// parser is critical drift, and a 500 is never reported as the parser being
// gone. What is specific here is the parser SCRIPT — the whole configuration. A
// script edited in the console silently changes how every event it normalizes
// is indexed, which breaks the detections and dashboards built on those fields,
// so it is reported as CRITICAL.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const SCRIPT = 'parseJson()\n| parseTimestamp(field=eventTime)\n| rename(src_ip, as=source.ip)'

const PARSER = item('Palo Alto traffic', {
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  datatype: 'paloalto:traffic',
  script: SCRIPT,
  enabled: true,
})

registerDriftContract({ label: 'ngsiem-parsers', handler: driftDetect, items: [PARSER] })

/** The live parser exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'parser-live-1',
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  script: SCRIPT,
  ...over,
})

/** The two-call lookup: the filtered id query, then the entity get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('ngsiem-parsers driftDetect: reports no drift when the script still matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([PARSER]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: reports a parser script edited in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ script: 'parseJson()\n| rename(src_ip, as=something.else)' })),
  )
  try {
    const result = await driftDetect(driftContext([PARSER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'paloalto-traffic.script')
    assert.ok(diff, `expected a script diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'declared parser script')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: ignores surrounding whitespace, which the API may normalize', async () => {
  const { restore } = recordFetch(lookup(live({ script: `\n${SCRIPT}\n` })))
  try {
    const result = await driftDetect(driftContext([PARSER]))

    assert.equal(
      result.hasDrift,
      false,
      `trimmed whitespace is not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: reports a parser moved to another repository', async () => {
  const { restore } = recordFetch(lookup(live({ repository: 'some-other-repository' })))
  try {
    const result = await driftDetect(driftContext([PARSER]))

    const diff = result.diffs.find((d) => d.field === 'paloalto-traffic.repository')
    assert.ok(diff, `expected a repository diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'parsers-repository')
    assert.equal(diff.actual, 'some-other-repository')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: makes no write when the API returns the parser without its script', async () => {
  // DEFECT (reported, not blessed): when the entity read answers without a
  // `script` field the handler compares nothing and returns a bare
  // `hasDrift: false`, which the platform reads as "I checked and it matches"
  // and uses to clear real drift. It wants `checked: false`. Only the half that
  // is certainly right is asserted here — that drift never writes.
  const { calls, restore } = recordFetch(
    lookup({ id: 'parser-live-1', name: 'paloalto-traffic', repository: 'parsers-repository' }),
  )
  try {
    await driftDetect(driftContext([PARSER]))

    assert.equal(writeCalls(calls).length, 0, 'drift must never write')
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        script: 'parseJson()',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([PARSER]))

    const diff = result.diffs.find((d) => d.field === 'paloalto-traffic.script')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ script: 'parseJson()', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([PARSER]))

    const diff = result.diffs.find((d) => d.field === 'paloalto-traffic.script')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ngsiem-parsers driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Palo Alto traffic', {
    name: 'paloalto-traffic',
    repository: 'parsers-repository',
    script: 'parseJson()\n| rename(not_yet_deployed, as=source.ip)',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([PARSER], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
