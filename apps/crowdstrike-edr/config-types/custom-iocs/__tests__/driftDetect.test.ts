// driftDetect for custom-iocs.
//
// The shared contract covers the invariants: drift never writes, a deleted
// indicator is critical drift, and a 500 is never reported as the indicator
// being gone. What is specific here is the comparison — and the one that decides
// whether a threat is blocked is `action`. An indicator downgraded from prevent
// to detect (or no_action) in the console still exists, still looks deployed,
// and no longer stops anything; that is exactly the case drift exists to catch.

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

const HASH = 'a3f1c0de4b2955ab7788c0d1e2f3a4b5c6d7e8f90112233445566778899aabbc'

const IOC = item('Loader hash from incident 4812', {
  type: 'sha256',
  value: HASH,
  action: 'prevent',
  severity: 'critical',
  platforms: 'windows, mac',
  appliedGlobally: true,
  expiration: '2026-12-31T00:00:00Z',
})

registerDriftContract({ label: 'custom-iocs', handler: driftDetect, items: [IOC] })

/** The live indicator exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'ioc-live-1',
  type: 'sha256',
  value: HASH,
  action: 'prevent',
  severity: 'critical',
  platforms: ['windows', 'mac'],
  applied_globally: true,
  expiration: '2026-12-31T00:00:00Z',
  ...over,
})

/** The two-call lookup every indicator read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('custom-iocs driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([IOC]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports an action downgraded from prevent to detect as critical', async () => {
  // The indicator still exists and still alerts, so nothing else flags it — but
  // the file it names is no longer blocked.
  const { restore } = recordFetch(lookup(live({ action: 'detect' })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${HASH}.action`)
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'prevent')
    assert.equal(diff.actual, 'detect')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports an action switched off entirely as critical', async () => {
  const { restore } = recordFetch(lookup(live({ action: 'no_action' })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.action`)
    assert.ok(diff)
    assert.equal(diff.actual, 'no_action')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports a severity downgrade as a warning', async () => {
  // Severity decides whether anyone triages the detection, so it drifts — but it
  // does not change whether the sensor acts, so it is not critical.
  const { restore } = recordFetch(lookup(live({ severity: 'informational' })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.severity`)
    assert.ok(diff, `expected a severity diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'critical')
    assert.equal(diff.actual, 'informational')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports a platform dropped in the console as critical', async () => {
  // Fewer platforms than declared means hosts of that platform are silently
  // unprotected by this indicator.
  const { restore } = recordFetch(lookup(live({ platforms: ['windows'] })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.platforms`)
    assert.ok(diff, `expected a platforms diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'windows')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports an extra platform as a warning, not critical', async () => {
  const { restore } = recordFetch(lookup(live({ platforms: ['windows', 'mac', 'linux'] })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.platforms`)
    assert.ok(diff)
    assert.equal(diff.severity, 'warning', 'nothing declared lost coverage')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports a globally applied indicator narrowed to host groups', async () => {
  // Scoping a global block to a handful of groups leaves the rest of the estate
  // unprotected while the indicator still reads as deployed.
  const { restore } = recordFetch(
    lookup(live({ applied_globally: false, host_groups: ['hg-lab'] })),
  )
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.appliedGlobally`)
    assert.ok(diff, `expected an appliedGlobally diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports host groups re-targeted on a non-global indicator', async () => {
  const TARGETED = item('Loader hash from incident 4812', {
    type: 'sha256',
    value: HASH,
    action: 'prevent',
    severity: 'critical',
    platforms: 'windows',
    appliedGlobally: false,
    hostGroups: 'hg-prod, hg-dmz',
  })
  const { restore } = recordFetch(
    lookup(
      live({
        platforms: ['windows'],
        applied_globally: false,
        host_groups: ['hg-lab'],
        expiration: undefined,
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([TARGETED]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.hostGroups`)
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-prod, hg-dmz')
    assert.equal(diff.actual, 'hg-lab')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reports an expiry brought forward in the console', async () => {
  // An indicator that now self-expires next month is still present today, so
  // only the expiry comparison catches it.
  const { restore } = recordFetch(lookup(live({ expiration: '2026-02-01T00:00:00Z' })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.expiration`)
    assert.ok(diff, `expected an expiration diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2026-12-31T00:00:00Z')
    assert.equal(diff.actual, '2026-02-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: ignores a formatting-only difference in the expiry instant', async () => {
  const { restore } = recordFetch(lookup(live({ expiration: '2026-12-31T00:00:00.000Z' })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    assert.equal(
      result.diffs.some((d) => d.field === `${HASH}.expiration`),
      false,
      `the same instant is not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: attributes a manual change to the operator who made it', async () => {
  // IOCs record the modifier in `modified_on`, not `modified_timestamp`.
  const { restore } = recordFetch(
    lookup(live({ action: 'detect', modified_by: 'alice@acme.com', modified_on: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.action`)
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ action: 'detect', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([IOC]))

    const diff = result.diffs.find((d) => d.field === `${HASH}.action`)
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('custom-iocs driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Loader hash from incident 4812', {
    type: 'sha256',
    value: HASH,
    action: 'detect',
    severity: 'low',
    platforms: 'linux',
    appliedGlobally: true,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([IOC], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
