// ============================================================================
// driftDetect for Conditional Access policies, against a fake Microsoft Graph.
//
// Drift on a CA policy is a security event: a policy someone disabled in the
// portal, or switched from report-only to enabled, changes who can sign in.
// These assert the diff the handler actually produces — including that it
// reports NOTHING (rather than a false "no drift") when it cannot read, and
// that a diff never carries the access token into the platform's drift record.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

/** groups, users, roleDefinitions, namedLocations, authStrengths, termsOfUse. */
function nameMaps() {
  return [0, 1, 2, 3, 4, 5].map(() => collection([]))
}

function mfaItem(fields: Record<string, unknown> = {}) {
  return item('Require MFA', {
    name: 'Require MFA',
    includeAllUsers: true,
    includeAllApps: true,
    builtInControls: ['mfa'],
    ...fields,
  })
}

const LIVE_MATCHING = {
  id: 'p-1',
  displayName: 'Require MFA',
  state: 'enabledForReportingButNotEnforced',
  conditions: {
    users: {
      includeUsers: ['All'],
      excludeUsers: [],
      includeGroups: [],
      excludeGroups: [],
      includeRoles: [],
      excludeRoles: [],
    },
    applications: { includeApplications: ['All'] },
  },
  grantControls: { operator: 'OR', builtInControls: ['mfa'] },
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([mfaItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  // Reading is all drift detection may do. When the read fails it reports
  // nothing rather than inventing "everything is absent".
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([LIVE_MATCHING]), ...nameMaps()])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assertAuthenticatedFirst(assert, calls)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted policy is critical drift', async () => {
  const { restore } = recordFetch([TOKEN, collection([]), ...nameMaps()])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Require MFA',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a report-only policy switched to enabled in the portal is critical drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([{ ...LIVE_MATCHING, state: 'enabled' }]),
    ...nameMaps(),
  ])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    assert.equal(result.hasDrift, true)
    const stateDiff = result.diffs.find((d) => d.field === 'Require MFA.state')
    assert.ok(stateDiff, `expected a state diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(stateDiff.expected, 'enabledForReportingButNotEnforced')
    assert.equal(stateDiff.actual, 'enabled')
    assert.equal(stateDiff.severity, 'critical')
  } finally {
    restore()
  }
})

test('an audience someone widened in the portal surfaces as a diff, and no diff carries the token', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([
      {
        ...LIVE_MATCHING,
        conditions: {
          ...LIVE_MATCHING.conditions,
          users: { ...LIVE_MATCHING.conditions.users, excludeUsers: ['GuestsOrExternalUsers'] },
        },
      },
    ]),
    ...nameMaps(),
  ])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    const excluded = result.diffs.find((d) => d.field === 'Require MFA.excludeUsers')
    assert.ok(excluded)
    assert.deepEqual(excluded.expected, [])
    assert.deepEqual(excluded.actual, ['GuestsOrExternalUsers'])
    assert.equal(leaksSecret(result), false, 'drift records are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a grant control someone removed surfaces as a diff', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([{ ...LIVE_MATCHING, grantControls: { operator: 'OR', builtInControls: [] } }]),
    ...nameMaps(),
  ])
  try {
    const result = await driftDetect(driftContext([mfaItem()]))

    const controls = result.diffs.find((d) => d.field === 'Require MFA.builtInControls')
    assert.ok(controls)
    assert.deepEqual(controls.expected, ['mfa'])
    assert.deepEqual(controls.actual, [])
  } finally {
    restore()
  }
})

test('a target name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = recordFetch([TOKEN, collection([LIVE_MATCHING]), ...nameMaps()])
  try {
    const result = await driftDetect(
      driftContext([mfaItem({ includeAllUsers: false, includeGroups: ['Ghost Group'] })]),
    )

    const unresolved = result.diffs.find((d) => d.field === 'Require MFA.users')
    assert.ok(unresolved)
    assert.equal(unresolved.severity, 'critical')
    assert.match(String(unresolved.actual), /Ghost Group/)
  } finally {
    restore()
  }
})
