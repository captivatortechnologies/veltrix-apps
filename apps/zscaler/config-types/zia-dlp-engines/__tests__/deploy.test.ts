// deploy for zia-dlp-engines.
//
// What is specific to this type and worth driving end to end:
//   * identity is `name` and the id is NUMERIC;
//   * the load-bearing field is `engineExpression` — the boolean rule over DLP
//     dictionaries that decides what the engine actually catches;
//   * a PREDEFINED engine (`customDlpEngine: false`) must never be overwritten;
//   * the update path must record the LIVE prior expression, which is the only
//     thing rollback can restore;
//   * ZIA stages writes, so a deploy that never reaches `/status/activate` has
//     changed nothing the customer can see.
//
// NOT asserted, deliberately: the path where the POST succeeds but the response
// carries no id. deploy throws there BEFORE pushing the rollback entry, so the
// engine exists in the tenant with nothing recorded — see the report.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const ENGINE = item('Acme Secret Leakage', {
  name: 'Acme Secret Leakage',
  description: 'desired description',
  engine_expression: '((D63.S > 1))',
  custom_dlp_engine: true,
})

/**
 * The live engine, deliberately UNLIKE the canvas: a different description and a
 * different expression. A rollback entry mirroring the canvas rather than this
 * has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 8801,
  name: 'Acme Secret Leakage',
  customDlpEngine: true,
  description: 'live description set by hand',
  engineExpression: '((D101.S > 5))',
}

const OTHER = { id: 8899, name: 'Something Else', customDlpEngine: true }

registerDeployGuardContract({ label: 'zia-dlp-engines', handler: deploy, product: 'zia', items: [ENGINE] })

test('zia-dlp-engines deploy: creates an engine that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER]),
    created({ id: 8810, name: 'Acme Secret Leakage' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([ENGINE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpEngines\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/dlpEngines$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Acme Secret Leakage')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.engineExpression, '((D63.S > 1))')
    assert.equal(body?.customDlpEngine, true)

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Acme Secret Leakage', existed: false, id: 8810 }])
    assert.deepEqual(rollback.createdIds, [8810])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-engines deploy: updates an existing engine and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 8801 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([ENGINE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'an engine that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/dlpEngines\/8801$/)
    assert.equal(bodyOf(tenant[1])?.engineExpression, '((D63.S > 1))')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 8801)
    assert.equal(entry.prior.engineExpression, '((D101.S > 5))', 'rollback must restore what was there')
    assert.equal(entry.prior.description, 'live description set by hand')
    assert.equal(entry.prior.customDlpEngine, true)
  } finally {
    restore()
  }
})

test('zia-dlp-engines deploy: refuses to overwrite a predefined engine, and writes nothing', async () => {
  const predefined = {
    id: 21,
    name: 'Acme Secret Leakage',
    customDlpEngine: false,
    predefinedEngineName: 'PCI',
  }
  const { calls, restore } = recordFetch([TOKEN, ziaList([predefined])])
  try {
    const result = await deploy(deployContext([ENGINE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined DLP engine/)
    assert.equal(writeCalls(calls).length, 0, 'a built-in engine must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'a predefined engine is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-dlp-engines deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Engine expression references an unknown dictionary'),
  ])
  try {
    const result = await deploy(deployContext([ENGINE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Engine expression references an unknown dictionary/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live engine, so the prior expression deploy
    // read beforehand has to survive on the failure path or it can never be
    // restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { engineExpression?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.engineExpression, '((D101.S > 5))')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-engines deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/dlpEngines/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([ENGINE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list DLP engines/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-engines deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER]),
    created({ id: 8810 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([ENGINE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [8810], 'the staged engine still exists and must be revertible')
  } finally {
    restore()
  }
})
