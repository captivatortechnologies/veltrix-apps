// ============================================================================
// driftDetect for Entra terms of use agreements, against a fake Graph.
//
// The severity split here is deliberate and worth pinning. Only two fields can
// be reconciled by a PATCH, so only those are `warning`; the create-only fields
// are `info`, because a "Correct" action against them would re-deploy forever
// without ever converging. And a truncated listing must NOT become a critical
// "absent" diff — that would report agreements as deleted on a read that simply
// never finished.
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
  page,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

function agreementItem(fields: Record<string, unknown> = {}) {
  return item('Acceptable Use Policy', {
    name: 'Acceptable Use Policy',
    viewingBeforeAcceptanceRequired: true,
    perDeviceAcceptanceRequired: false,
    reacceptFrequency: 'P365D',
    expirationStartDate: '2026-01-01T00:00:00Z',
    expirationFrequency: 'P365D',
    ...fields,
  })
}

function liveAgreement(over: Record<string, unknown> = {}) {
  return {
    id: 'a-1',
    displayName: 'Acceptable Use Policy',
    isViewingBeforeAcceptanceRequired: true,
    isPerDeviceAcceptanceRequired: false,
    userReacceptRequiredFrequency: 'P365D',
    termsExpiration: { startDateTime: '2026-01-01T00:00:00Z', frequency: 'P365D' },
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([agreementItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([agreementItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and, crucially, writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live agreement matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveAgreement()])])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'GET')
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('an agreement deleted out of band is critical drift', async () => {
  // Whatever Conditional Access policy required it now grants access with no
  // acceptance step at all.
  const { restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Acceptable Use Policy',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('viewing-before-acceptance turned off in the portal is a correctable warning', async () => {
  // Without it a user accepts a document they were never shown — and this is one
  // of the two fields a PATCH can actually put back, hence `warning` not `info`.
  const { restore } = recordFetch([TOKEN, collection([liveAgreement({ isViewingBeforeAcceptanceRequired: false })])])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.equal(result.diffs.length, 1)
    assert.deepEqual(result.diffs[0], {
      field: 'Acceptable Use Policy.viewingBeforeAcceptanceRequired',
      expected: true,
      actual: false,
      severity: 'warning',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a re-accept frequency that no longer matches is reported as informational, not correctable', async () => {
  // A PATCH cannot change it, so flagging it `warning` would invite a "Correct"
  // action that re-deploys forever without converging.
  const { restore } = recordFetch([TOKEN, collection([liveAgreement({ userReacceptRequiredFrequency: 'P180D' })])])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.deepEqual(result.diffs[0], {
      field: 'Acceptable Use Policy.reacceptFrequency (create-only; recreate to change)',
      expected: 'P365D',
      actual: 'P180D',
      severity: 'info',
    })
  } finally {
    restore()
  }
})

test('per-device acceptance and the expiration schedule are informational too', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([
      liveAgreement({
        isPerDeviceAcceptanceRequired: true,
        termsExpiration: { startDateTime: '2027-06-01T00:00:00Z', frequency: 'P90D' },
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.deepEqual(
      result.diffs.map((d) => [d.field, d.severity]),
      [
        ['Acceptable Use Policy.perDeviceAcceptanceRequired (create-only; recreate to change)', 'info'],
        ['Acceptable Use Policy.expirationStartDate (create-only; recreate to change)', 'info'],
        ['Acceptable Use Policy.expirationFrequency (create-only; recreate to change)', 'info'],
      ],
    )
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('the same expiration instant written in another format is not drift', async () => {
  // Graph may hand the timestamp back with sub-second precision or an offset; a
  // string compare would report permanent drift on an unchanged agreement.
  const { restore } = recordFetch([
    TOKEN,
    collection([
      liveAgreement({ termsExpiration: { startDateTime: '2026-01-01T00:00:00.0000000+00:00', frequency: 'P365D' } }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('a truncated listing never becomes a false "absent" — it is reported as unverified instead', async () => {
  const { calls, restore } = routeFetch([
    {
      url: /identityGovernance\/termsOfUse\/agreements/,
      respond: page([], 'https://graph.microsoft.com/v1.0/identityGovernance/termsOfUse/agreements?$skiptoken=more'),
    },
  ])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.equal(
      result.diffs.filter((d) => d.severity === 'critical').length,
      0,
      'an unfinished read must never claim a declared agreement was deleted',
    )
    assert.deepEqual(result.diffs, [
      {
        field: '(agreement listing)',
        expected: 'complete',
        actual: 'truncated at 0+ agreements — absence of declared agreements not verified',
        severity: 'info',
      },
    ])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an agreement is matched case-insensitively by display name', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveAgreement({ displayName: 'ACCEPTABLE USE POLICY' })])])
  try {
    const result = await driftDetect(driftContext([agreementItem()]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] }, 'a case difference must not read as a deleted agreement')
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an edit that has not been deployed yet', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveAgreement()])])
  try {
    const result = await driftDetect(
      driftContext([agreementItem({ viewingBeforeAcceptanceRequired: false })], {
        deployedItems: [agreementItem()],
      }),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})
