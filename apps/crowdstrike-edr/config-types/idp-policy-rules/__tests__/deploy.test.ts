// deploy for idp-policy-rules — REPLACE-IN-PLACE, so every assertion here is
// about a DELETE.
//
// The Identity Protection API has no PATCH for policy rules, so changing one
// means deleting the live rule and creating a replacement. Between those two
// calls the organisation's authentication policy does not exist, and the rule
// cannot be restored under its original id. That makes three things load
// bearing: a rule that already matches must NOT be replaced, a rule that could
// not be READ must never be treated as absent, and the prior rule's recreatable
// body must be recorded BEFORE the delete goes out.
// The shared contract covers the pre-flight refusals.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CREATED_WITHOUT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  created,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  serverError,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERY = /\/identity-protection\/queries\/policy-rules\/v1/
const ENTITY = /\/identity-protection\/entities\/policy-rules\/v1/

/**
 * One declared rule. `extractIdpRuleSpecs` reads a FLAT `fields` record off each
 * canvas item — `name`, `enabled`, `simulationMode`, `action`, `conditions` (a
 * JSON string) and `precedence` (a numeric STRING; a number is ignored).
 */
const RULE = item('Block legacy auth', {
  name: 'Block legacy authentication',
  enabled: 'true',
  simulationMode: 'false',
  action: 'DENY',
  conditions: '{"activity":{"accessType":["LEGACY"]}}',
})

/**
 * The rule as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 * `name` is the identity and must match.
 */
const LIVE_RULE = {
  id: 'rule-live-1',
  name: 'Block legacy authentication',
  enabled: false,
  simulationMode: true,
  action: 'ALLOW',
  activity: { accessType: ['RDP'] },
}

registerDeployGuardContract({ label: 'idp-policy-rules', handler: deploy, items: [RULE] })

/** Routes for a rule that already exists and differs from the canvas. */
function existingRule(over: { live?: Record<string, unknown>; create?: ReturnType<typeof ok>; del?: ReturnType<typeof ok> } = {}) {
  return routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([over.live ?? LIVE_RULE]) },
    { url: ENTITY, method: 'DELETE', respond: over.del ?? ok() },
    { url: ENTITY, method: 'POST', respond: over.create ?? created({ id: 'rule-new-2' }) },
    { url: QUERY, respond: idsPage(['rule-live-1']) },
  ])
}

test('idp-policy-rules deploy: creates a rule that does not exist yet, and deletes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'Block legacy authentication')
    assert.equal(body?.enabled, true)
    assert.equal(body?.simulationMode, false)
    assert.equal(body?.action, 'DENY')
    assert.deepEqual(body?.activity, { accessType: ['LEGACY'] })

    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a rule that did not exist must never cost an existing one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: records the created rule so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ name: string; existed: boolean; replaced: boolean; createdId?: string }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'Block legacy authentication')
    assert.equal(state[0].existed, false, 'a rule this deploy created is not pre-existing')
    assert.equal(state[0].replaced, false)
    assert.equal(state[0].createdId, 'rule-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: leaves an already-matching rule completely untouched', async () => {
  // There is no PATCH here, so "converging" a rule that is already correct would
  // mean deleting the organisation's live authentication policy and recreating
  // it under a new id, for nothing.
  const { calls, restore } = existingRule({
    live: {
      id: 'rule-live-1',
      name: 'Block legacy authentication',
      enabled: true,
      simulationMode: false,
      action: 'DENY',
      activity: { accessType: ['LEGACY'] },
    },
  })
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)

    const state = (result.rollbackData as { previousState?: Array<{ existed: boolean; replaced: boolean }> })
      ?.previousState
    assert.ok(state)
    assert.equal(state[0].existed, true)
    assert.equal(state[0].replaced, false, 'a no-op must be recorded as one so rollback skips it')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: replaces a changed rule, deleting the old one before creating the new', async () => {
  const { calls, restore } = existingRule()
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)

    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=rule-live-1/)

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.enabled, true)
    assert.equal(body?.action, 'DENY')
    assert.deepEqual(body?.activity, { accessType: ['LEGACY'] })

    const sequence = vendorCalls(calls).map((c) => c.method)
    assert.ok(
      sequence.indexOf('DELETE') < sequence.indexOf('POST'),
      `replace-in-place deletes before it creates, got ${sequence.join(' → ')}`,
    )
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: records the LIVE prior rule BEFORE deleting it', async () => {
  // The canvas asks for enabled/DENY/LEGACY; the tenant holds
  // disabled/ALLOW/RDP. Rollback recreates what was there, not what was wanted,
  // and the record must survive a delete that succeeded and a create that did
  // not — so the prior body is captured before either call.
  const { restore } = existingRule()
  try {
    const result = await deploy(deployContext([RULE]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          existed: boolean
          replaced: boolean
          deleted?: boolean
          priorId?: string
          createdId?: string
          priorRule?: Record<string, unknown>
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].replaced, true)
    assert.equal(state[0].deleted, true)
    assert.equal(state[0].priorId, 'rule-live-1')
    assert.equal(state[0].createdId, 'rule-new-2')

    const prior = state[0].priorRule
    assert.ok(prior, 'a replaced rule with no recorded prior cannot be brought back')
    assert.equal(prior.name, 'Block legacy authentication')
    assert.equal(prior.enabled, false)
    assert.equal(prior.simulationMode, true)
    assert.equal(prior.action, 'ALLOW')
    assert.deepEqual(prior.activity, { accessType: ['RDP'] })
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: a delete that succeeded and a create that failed still leaves the prior rule recoverable', async () => {
  // This is the window the whole design turns on: the live rule is gone and its
  // replacement was rejected. Rollback can only put the policy back if deploy
  // wrote the prior body down first.
  const { restore } = existingRule({ create: forbidden('access denied, authorization failed') })
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    const state = (
      result.rollbackData as {
        previousState?: Array<{ deleted?: boolean; priorRule?: Record<string, unknown>; createdId?: string }>
      }
    )?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state[0].deleted, true, 'the prior rule really was removed')
    assert.ok(state[0].priorRule, 'without the prior body the policy cannot be restored')
    assert.equal(state[0].createdId, undefined, 'nothing was created to clean up')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: a rule that could not be READ is never treated as absent', async () => {
  // A 500 on the name query is "I could not look". Reading it as "no such rule"
  // would create a duplicate rule beside the live one — two authentication
  // policies under one name.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `an unreadable tenant must not be written to: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: a failed rule detail read stops the deploy too', async () => {
  // The id query resolved but the entity read failed. Same rule: an unknown
  // live rule must not become "absent, so create".
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: serverError() },
    { url: QUERY, respond: idsPage(['rule-live-1']) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: never replaces a rule the canvas did not declare', async () => {
  // The query is a loose `name=` lookup. Adopting whatever it returns would
  // DELETE an unrelated Identity Protection rule.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([{ id: 'rule-other-1', name: 'Some other rule', enabled: true }]) },
    { url: ENTITY, method: 'POST', respond: created({ id: 'rule-new-1' }) },
    { url: QUERY, respond: idsPage(['rule-other-1']) },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      `deploy deleted a rule it never declared: ${describeCalls(callsOfMethod(calls, 'DELETE'))}`,
    )
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the declared rule is created alongside it')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: refuses invalid conditions JSON before touching the vendor', async () => {
  const bad = item('Block legacy auth', {
    name: 'Block legacy authentication',
    action: 'DENY',
    conditions: '{ not json',
  })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([bad]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid conditions/)
    assert.equal(calls.length, 0, 'a malformed rule body must not cost a request')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: creates lower-precedence rules first', async () => {
  // The REST API has no precedence field — creation order is the only lever
  // over rule ordering, so the sort has to be observable in the request stream.
  const first = item('Allow break glass', {
    name: 'Allow break glass',
    action: 'ALLOW',
    precedence: '10',
  })
  const second = item('Block legacy auth', {
    name: 'Block legacy authentication',
    action: 'DENY',
    precedence: '20',
  })
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: [created({ id: 'rule-new-1' }), created({ id: 'rule-new-2' })] },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    await deploy(deployContext([second, first]))

    const names = callsOfMethod(calls, 'POST').map((c) => bodyOf(c)?.name)
    assert.deepEqual(names, ['Allow break glass', 'Block legacy authentication'])
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a rule it never created as deployed — and, on the
  // replace path, has already deleted the one that worked.
  const { restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: partialFailure('policy rule limit reached') },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /policy rule limit reached/)
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createRule` throws here AFTER the POST
  // succeeded, and on the fresh-create path `rollbackState.push` only runs on
  // the line below it — so the rule now exists in the tenant with nothing
  // recorded to delete it. What is asserted is only the half that is certainly
  // right: the deploy does not claim success. The rollback record it fails to
  // keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
    { url: QUERY, respond: EMPTY },
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no rule id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the rule was in fact created')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: a replacement created without an id still records the deleted prior rule', async () => {
  // Same defect on the replace path, with a different consequence: the entry IS
  // recorded (it was pushed before the delete), so rollback will recreate the
  // prior rule — but `createdId` is never set, so the replacement it cannot see
  // is left behind and the tenant ends up with TWO rules of this name.
  // Only the half that is certainly right is asserted here.
  const { restore } = existingRule({ create: CREATED_WITHOUT_ID })
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no rule id/i)
    const state = (
      result.rollbackData as { previousState?: Array<{ deleted?: boolean; priorRule?: Record<string, unknown> }> }
    )?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state[0].deleted, true)
    assert.ok(state[0].priorRule, 'the prior rule is still recoverable')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = existingRule()
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('idp-policy-rules deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
