// driftDetect for installation-tokens.
//
// The shared contract covers the invariants: drift never writes, a deleted token
// is critical drift, and a 500 is never reported as the token being gone. What
// is specific here is the comparison itself — the revoke state (which decides
// whether sensors can be enrolled at all, hence critical) and the expiry — plus
// the rule that the token VALUE is never read, compared, or written into a diff.

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

/** The token secret the fake tenant returns on every read. */
const TOKEN_VALUE = 'falcon-installation-token-value-MUST-NOT-LEAK'

const TOKEN_ITEM = item('Workstation rollout', {
  label: 'workstation-rollout',
  expiresTimestamp: '2026-12-31T00:00:00Z',
  revoked: false,
})

registerDriftContract({ label: 'installation-tokens', handler: driftDetect, items: [TOKEN_ITEM] })

/** The live token exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'tok-live-1',
  label: 'workstation-rollout',
  value: TOKEN_VALUE,
  expires_timestamp: '2026-12-31T00:00:00Z',
  status: 'active',
  ...over,
})

/** The two-call lookup this config type performs: id listing, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('installation-tokens driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: reports a token revoked in the console as critical drift', async () => {
  // A revoked token cannot enrol sensors — every new machine silently fails to
  // install until somebody notices.
  const { restore } = recordFetch(lookup(live({ status: 'revoked' })))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'workstation-rollout.revoked')
    assert.ok(diff, `expected a revoked diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, false)
    assert.equal(diff.actual, true)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: reads the revoke state from a revoked_timestamp too', async () => {
  // The read shape has no `revoked` boolean; a tenant that reports the revoke
  // only as a timestamp must not come back as "in sync".
  const noStatus = live({ revoked_timestamp: '2026-02-01T00:00:00Z' })
  delete (noStatus as { status?: unknown }).status
  const { restore } = recordFetch(lookup(noStatus))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    const diff = result.diffs.find((d) => d.field === 'workstation-rollout.revoked')
    assert.ok(diff, `expected a revoked diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, true)
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: reports an expiry brought forward in the console', async () => {
  const { restore } = recordFetch(lookup(live({ expires_timestamp: '2026-06-01T00:00:00Z' })))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    const diff = result.diffs.find((d) => d.field === 'workstation-rollout.expiresTimestamp')
    assert.ok(diff, `expected an expiry diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2026-12-31T00:00:00Z')
    assert.equal(diff.actual, '2026-06-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: reports an expiry added to a token declared to never expire', async () => {
  const forever = item('Lab rollout', { label: 'lab-rollout', expiresTimestamp: '', revoked: false })
  const { restore } = recordFetch(
    lookup(live({ label: 'lab-rollout', expires_timestamp: '2026-06-01T00:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([forever]))

    const diff = result.diffs.find((d) => d.field === 'lab-rollout.expiresTimestamp')
    assert.ok(diff, `expected an expiry diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'never')
    assert.equal(diff.actual, '2026-06-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: treats an equivalent RFC3339 instant as no drift', async () => {
  // Falcon echoes the expiry with millisecond precision; comparing the strings
  // would report drift on every run of a tenant nobody has touched.
  const { restore } = recordFetch(lookup(live({ expires_timestamp: '2026-12-31T00:00:00.000Z' })))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    assert.equal(result.hasDrift, false, `same instant drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: never puts the token value in a diff', async () => {
  // The live read carries the enrolment secret. Drift records are stored and
  // surfaced widely — the value is not part of the managed configuration and
  // must not travel with the diff.
  const { restore } = recordFetch(lookup(live({ status: 'revoked' })))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    assert.equal(result.hasDrift, true, 'the drift itself is still reported')
    assert.equal(
      (JSON.stringify(result) ?? '').includes(TOKEN_VALUE),
      false,
      'the token secret escaped into the drift result',
    )
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: does not invent an actor when Falcon records no modifier', async () => {
  // Installation tokens expose no modifier field today. Attribution must stay
  // empty rather than guessing at who revoked the token.
  const { restore } = recordFetch(lookup(live({ status: 'revoked' })))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    const diff = result.diffs.find((d) => d.field === 'workstation-rollout.revoked')
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: does not attribute drift to our own API client', async () => {
  // Wired for the day Falcon starts populating a modifier: a change last written
  // by the connection's own API client is a Veltrix deploy, not a manual edit.
  const { restore } = recordFetch(lookup(live({ status: 'revoked', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM]))

    const diff = result.diffs.find((d) => d.field === 'workstation-rollout.revoked')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('installation-tokens driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Workstation rollout', {
    label: 'workstation-rollout',
    expiresTimestamp: '2027-12-31T00:00:00Z',
    revoked: false,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([TOKEN_ITEM], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
