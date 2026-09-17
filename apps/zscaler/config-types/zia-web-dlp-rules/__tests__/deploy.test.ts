// deploy for zia-web-dlp-rules.
//
// What is specific to this type:
//   * it is a JSON-BODY policy rule — the `rule_json` escape hatch carries the
//     DLP engine and label references as `{ id }` lists and is merged into the
//     body, with the rule NAME forced back from the name field afterwards so the
//     JSON can never hijack the rule's identity;
//   * ZIA ships a PROTECTED default (catch-all) DLP rule that must never be
//     written to, flagged by any of isDefaultRule/defaultRule/predefined;
//   * the update path captures the WHOLE live rule, because that is the only
//     thing rollback can PUT back;
//   * ZIA stages writes, so a deploy that does not reach `/status/activate` has
//     changed nothing the customer can see.

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
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const RULE = item('Block PII uploads', {
  name: 'Block PII uploads',
  order: 2,
  state: 'ENABLED',
  action: 'BLOCK',
  protocols: 'HTTP_RULE\nHTTPS_RULE',
  rule_json: '{"name":"hijacked by the JSON","dlpEngines":[{"id":42}],"labels":[{"id":7}]}',
})

/**
 * The live rule, deliberately UNLIKE the canvas: disabled, allowing, ordered
 * last and pointed at a different DLP engine. A rollback entry that mirrors the
 * canvas rather than this has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 7331,
  name: 'Block PII uploads',
  order: 8,
  rank: 4,
  state: 'DISABLED',
  action: 'ALLOW',
  protocols: ['ANY_RULE'],
  dlpEngines: [{ id: 99, name: 'Legacy engine' }],
  description: 'hand-tuned in the ZIA console',
}

registerDeployGuardContract({ label: 'zia-web-dlp-rules', handler: deploy, product: 'zia', items: [RULE] })

test('zia-web-dlp-rules deploy: creates a rule that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 77, name: 'Something Else' }]),
    created({ id: 7401, name: 'Block PII uploads' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/webDlpRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/webDlpRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Block PII uploads', 'the JSON escape hatch must never override the identity')
    assert.equal(body?.order, 2)
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.action, 'BLOCK')
    assert.deepEqual(body?.protocols, ['HTTP_RULE', 'HTTPS_RULE'])
    assert.deepEqual(body?.dlpEngines, [{ id: 42 }], 'references are sent as { id } lists, verbatim')
    assert.deepEqual(body?.labels, [{ id: 7 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Block PII uploads', existed: false, id: 7401 }])
    assert.deepEqual(rollback.createdIds, [7401])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: normalises the state and action, and defaults the order and protocols', async () => {
  // A rule with no protocols would never match, and ZIA requires an order.
  const minimal = item('Block source code', { name: 'Block source code', state: 'enabled', action: 'confirm' })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 7402 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([minimal]))

    const body = bodyOf(calls.filter((c) => c.method === 'POST' && c.url.includes('/webDlpRules'))[0])
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.action, 'CONFIRM')
    assert.equal(body?.order, 1)
    assert.deepEqual(body?.protocols, ['ANY_RULE'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 7331 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/webDlpRules\/7331$/)
    assert.equal(bodyOf(tenant[1])?.action, 'BLOCK')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ name: string; existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 7331)
    assert.equal(entry.prior.action, 'ALLOW', 'rollback must restore what was there')
    assert.equal(entry.prior.state, 'DISABLED')
    assert.equal(entry.prior.order, 8)
    assert.equal(entry.prior.rank, 4)
    assert.deepEqual(entry.prior.dlpEngines, [{ id: 99, name: 'Legacy engine' }])
    assert.equal(entry.prior.description, 'hand-tuned in the ZIA console', 'unmanaged fields are captured too')
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: refuses to overwrite the protected default rule, and writes nothing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Block PII uploads', isDefaultRule: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /protected default web DLP rule/)
    assert.equal(writeCalls(calls).length, 0, 'the built-in catch-all rule must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: treats a rule flagged only `predefined` as protected too', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Block PII uploads', predefined: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /protected default web DLP rule/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: refuses a rule whose JSON escape hatch is malformed', async () => {
  const broken = item('Broken rule', { name: 'Broken rule', rule_json: '{"dlpEngines": [' })
  const { calls, restore } = recordFetch([TOKEN, ziaList([])])
  try {
    const result = await deploy(deployContext([broken]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /advanced criteria is not a valid JSON object/)
    assert.equal(resourceWrites(calls).length, 0, 'a malformed criteria object must never be sent')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Referenced DLP engine 42 does not exist'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Referenced DLP engine 42 does not exist/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live rule, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { action?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.action, 'ALLOW')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/webDlpRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list web DLP rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 7401 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [7401], 'the staged rule still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-web-dlp-rules deploy: a create whose response carries no id fails rather than throwing', async () => {
  // NOTE: what rollbackData holds here is deliberately NOT asserted. The POST
  // succeeded, so the rule exists in the tenant, but deploy throws on the missing
  // id BEFORE pushing a rollback entry — see the report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ name: 'Block PII uploads' })])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
