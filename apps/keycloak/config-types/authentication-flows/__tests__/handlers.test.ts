// =============================================================================
// Keycloak Authentication Flows — deploy / rollback / healthCheck /
// driftDetect / getStatus driven end to end against the fake Keycloak.
//
// The safety rule is the point of this config type: Keycloak's own built-in
// flows (browser, direct grant, reset credentials, …) are the realm's login
// path. Rewriting or deleting one locks everybody out, so deploy AND rollback
// must refuse to touch a live flow whose builtIn flag is set.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import healthCheck from '../healthCheck'
import driftDetect from '../driftDetect'
import getStatus from '../getStatus'
import {
  TOKEN,
  adminPath,
  bodyOf,
  created,
  deployContext,
  driftContext,
  isTokenCall,
  item,
  kcError,
  leaksToken,
  noContent,
  notFound,
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const STEP_UP = { alias: 'step-up-browser', description: 'Browser flow with step-up MFA', providerId: 'basic-flow' }

function liveFlow(over: Record<string, unknown> = {}) {
  return {
    id: 'flow-uuid',
    alias: 'step-up-browser',
    description: 'Browser flow with step-up MFA',
    providerId: 'basic-flow',
    topLevel: true,
    builtIn: false,
    ...over,
  }
}

const BUILT_IN_BROWSER = {
  id: 'builtin-uuid',
  alias: 'step-up-browser',
  description: 'Keycloak browser based authentication',
  providerId: 'basic-flow',
  topLevel: true,
  builtIn: true,
}

// --- deploy -------------------------------------------------------------------

test('authentication-flows deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('flow', STEP_UP)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authentication-flows deploy refuses to modify a built-in flow and writes nothing', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([BUILT_IN_BROWSER])])
  try {
    const result = await deploy(deployContext([item('flow', STEP_UP)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /refusing to modify built-in flow "step-up-browser"/)
    assert.equal(writeCalls(calls).length, 0, "a realm's own login flow must never be rewritten")
  } finally {
    restore()
  }
})

test('authentication-flows deploy creates a custom top-level flow and re-lists to capture its id', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([BUILT_IN_BROWSER].map((f) => ({ ...f, alias: 'browser' }))), // unrelated built-ins only
    created(),
    ok([liveFlow()]), // POST returns no id in the body — re-list and match by alias
  ])
  try {
    const result = await deploy(deployContext([item('flow', STEP_UP)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /authentication/flows', 'POST /authentication/flows', 'GET /authentication/flows'],
    )
    assert.deepEqual(bodyOf(vendor[1]), {
      alias: 'step-up-browser',
      providerId: 'basic-flow',
      topLevel: true,
      builtIn: false,
      description: 'Browser flow with step-up MFA',
    })
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [
      { alias: 'step-up-browser', id: 'flow-uuid', flow: null },
    ])
  } finally {
    restore()
  }
})

test('authentication-flows deploy forces builtIn false even when the canvas says otherwise', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([]), created(), ok([liveFlow()])])
  try {
    await deploy(deployContext([item('flow', { ...STEP_UP, builtIn: true, topLevel: false })]))

    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    assert.equal(body.builtIn, false, 'a custom top-level flow is the only safe thing to author')
    assert.equal(body.topLevel, true)
  } finally {
    restore()
  }
})

test('authentication-flows deploy updates an existing custom flow by internal id, not by alias', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveFlow()]), noContent()])
  try {
    await deploy(deployContext([item('flow', { ...STEP_UP, description: 'Reworded' })]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /authentication/flows', 'PUT /authentication/flows/flow-uuid'],
    )
    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.description, 'Reworded')
    assert.equal(body.providerId, 'basic-flow', 'providerId is immutable after creation and must not be rewritten')
  } finally {
    restore()
  }
})

test('authentication-flows deploy records the LIVE prior flow for rollback, not the desired values', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveFlow({ description: 'Original' })]), noContent()])
  try {
    const result = await deploy(deployContext([item('flow', { ...STEP_UP, description: 'Reworded' })]))

    const previous = (result.rollbackData as { previous: Array<{ flow: { description: string } }> }).previous
    assert.equal(previous[0].flow.description, 'Original')
  } finally {
    restore()
  }
})

test('authentication-flows deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([]), kcError(409, 'New Flow Alias name already exists')])
  try {
    const result = await deploy(deployContext([item('flow', STEP_UP)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('authentication-flows deploy skips an item with a blank alias without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...STEP_UP, alias: '' })]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authentication-flows deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveFlow()]), noContent()])
  try {
    const result = await deploy(deployContext([item('flow', STEP_UP)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('authentication-flows rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authentication-flows rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'step-up-browser', id: 'flow-uuid', flow: liveFlow() }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authentication-flows rollback re-checks builtIn before restoring and refuses if it is set', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([BUILT_IN_BROWSER])])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'step-up-browser', id: 'flow-uuid', flow: liveFlow() }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /refusing to modify built-in flow/)
    assert.equal(writeCalls(calls).length, 0, 'the guard must hold on the rollback path too, not just deploy')
  } finally {
    restore()
  }
})

test('authentication-flows rollback restores the captured prior flow verbatim', async () => {
  const prior = liveFlow({ description: 'Original' })
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveFlow()]), noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'step-up-browser', id: 'flow-uuid', flow: prior }] }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /authentication/flows', 'PUT /authentication/flows/flow-uuid'],
    )
    assert.deepEqual(bodyOf(vendor[1]), prior)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('authentication-flows rollback deletes a flow the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, ok([liveFlow()]), noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'step-up-browser', id: 'flow-uuid', flow: null }] }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /authentication/flows', 'DELETE /authentication/flows/flow-uuid'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, ok([]), notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'step-up-browser', id: 'flow-uuid', flow: null }] }),
    )
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('authentication-flows rollback skips an entry whose internal id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'step-up-browser', id: null, flow: null }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authentication-flows rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveFlow()]), kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'step-up-browser', id: 'flow-uuid', flow: liveFlow() }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('authentication-flows driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('flow', STEP_UP)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authentication-flows driftDetect reports no drift when the live flow matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveFlow()])])
  try {
    const result = await driftDetect(driftContext([item('flow', STEP_UP)]))

    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('authentication-flows driftDetect reports a description rewritten in the console', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveFlow({ description: 'Edited in console' })])])
  try {
    const result = await driftDetect(driftContext([item('flow', STEP_UP)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['step-up-browser.description'],
    )
  } finally {
    restore()
  }
})

test('authentication-flows driftDetect stays silent about a built-in flow it does not own', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([BUILT_IN_BROWSER])])
  try {
    const result = await driftDetect(driftContext([item('flow', STEP_UP)]))

    // A built-in is never ours to change, so diffing it would be permanent,
    // un-actionable noise on every scan.
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('authentication-flows driftDetect skips a flow it cannot read rather than asserting false drift', async () => {
  const unreadable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('flow', STEP_UP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unreadable.restore()
  }

  const absent = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await driftDetect(driftContext([item('flow', STEP_UP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    absent.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('authentication-flows', healthCheck)
describeGetStatusContract('authentication-flows', getStatus, 'keycloak-authentication-flows')
