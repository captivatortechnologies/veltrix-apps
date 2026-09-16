// ============================================================================
// deploy for Entra activity based timeout policies, against a fake Graph.
//
// This policy is what tears a signed-in web session down after a period of
// inactivity — the control that stops an unattended browser on a shared machine
// staying authenticated all day. Two fields decide that: the `definition` (which
// carries the idle timeout itself) and `isOrganizationDefault`, which applies a
// policy to every application in the tenant at once. Both are asserted on the
// wire, byte for byte.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/policies/activityBasedTimeoutPolicies'

/** A one-hour web-session idle timeout for the default application. */
const ONE_HOUR =
  '{"ActivityBasedTimeoutPolicy":{"Version":1,"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"01:00:00"}]}}'
/** The same policy relaxed to eight hours — a full working day unattended. */
const EIGHT_HOURS =
  '{"ActivityBasedTimeoutPolicy":{"Version":1,"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"08:00:00"}]}}'

function timeoutItem(fields: Record<string, unknown> = {}) {
  return item('Kiosk timeout', { name: 'Kiosk timeout', definition: ONE_HOUR, ...fields })
}

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'Kiosk timeout',
    definition: [EIGHT_HOURS],
    isOrganizationDefault: false,
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([timeoutItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('deploy refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([timeoutItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([timeoutItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list activity based timeout policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy authenticates first and POSTs a policy that does not exist yet', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'p-new' })])
  try {
    const result = await deploy(deployContext([timeoutItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)
    assert.equal(graphCalls[0].method, 'GET')

    assert.equal(graphCalls[1].method, 'POST')
    assert.ok(graphCalls[1].url.endsWith(BASE), `POST target was ${graphCalls[1].url}`)
    assert.deepEqual(bodyOf(graphCalls[1]), {
      displayName: 'Kiosk timeout',
      // Graph stores the definition as a single-element array of JSON text.
      definition: [ONE_HOUR],
      isOrganizationDefault: false,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false, 'nothing was there before, so rollback must delete it')
    assert.equal(entries[0].id, 'p-new', 'the created id has to be recorded or rollback cannot find it')
    assert.equal(entries[0].prior, undefined)
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a policy is not made the organization default unless the canvas says so', async () => {
  // isOrganizationDefault applies the timeout to EVERY application in the
  // tenant. Inferring it from silence would change sign-in behaviour tenant-wide.
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'p-new' })])
  try {
    await deploy(deployContext([timeoutItem()]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.isOrganizationDefault, false)
  } finally {
    restore()
  }
})

test('the organization default flag is sent true only when the canvas sets it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'p-new' })])
  try {
    await deploy(deployContext([timeoutItem({ isOrganizationDefault: true })]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.isOrganizationDefault, true)
  } finally {
    restore()
  }
})

test('deploy PATCHes an existing policy and records its LIVE prior definition', async () => {
  // The tenant is running an eight-hour idle timeout; the canvas tightens it to
  // one hour. Rollback has to be able to put the eight-hour text back verbatim.
  const { calls, restore } = recordFetch([TOKEN, collection([livePolicy()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([timeoutItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/p-1`))
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'Kiosk timeout',
      definition: [ONE_HOUR],
      isOrganizationDefault: false,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'p-1')
    assert.deepEqual(entries[0].prior, {
      displayName: 'Kiosk timeout',
      definition: [EIGHT_HOURS],
      isOrganizationDefault: false,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]), 'the prior must be the live state, not the desired one')
  } finally {
    restore()
  }
})

test('the prior records the organization-default flag the tenant actually had', async () => {
  const { restore } = recordFetch([TOKEN, collection([livePolicy({ isOrganizationDefault: true })]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([timeoutItem({ isOrganizationDefault: false })]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal((entries[0].prior as Record<string, unknown>).isOrganizationDefault, true)
  } finally {
    restore()
  }
})

test('a policy renamed in the portal is matched by its recorded id, not duplicated', async () => {
  // Matching only on displayName would POST a second policy alongside the
  // renamed one, leaving two competing timeouts in the tenant.
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([livePolicy({ displayName: 'Renamed in the portal' })]),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(
      deployContext([timeoutItem()], {
        priorRollbackData: { entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1', prior: {} }] },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'a rename must not become a create')
    assert.ok(writes[0].url.endsWith(`${BASE}/p-1`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an item with no name is skipped — nothing is written for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([item('', { definition: ONE_HOUR })]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'Only one policy can be the organization default.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([timeoutItem({ isOrganizationDefault: true })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some activity based timeout policies failed/)
    assert.match(String(result.message), /Kiosk timeout: .*organization default/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a failure on one policy still records rollback state for the one that landed', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    created({ id: 'p-new' }),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(
      deployContext([timeoutItem(), timeoutItem({ name: 'Finance timeout' })]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'p-new')
  } finally {
    restore()
  }
})

test('reconcile deletes a policy this app created and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: { entries: [{ name: 'Retired timeout', existed: false, id: 'p-old' }] },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.endsWith(`${BASE}/p-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reconcile leaves a policy that pre-existed this app alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([livePolicy({ id: 'p-keep' })])])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [{ name: 'Pre-existing timeout', existed: true, id: 'p-keep', prior: { displayName: 'Pre-existing timeout' } }],
        },
      }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a rejected token exchange stops the deploy without a single Graph call', async () => {
  const { calls, restore } = recordFetch([
    { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' } },
  ])
  try {
    const result = await deploy(deployContext([timeoutItem()]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph request may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
