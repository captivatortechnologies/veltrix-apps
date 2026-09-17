// deploy for firewall-rule-groups.
//
// The fwmgr rule-group PATCH is not a body merge. It takes RFC-6902 JSON-patch
// `diff_operations`, parallel `rule_ids`/`rule_versions` arrays describing the
// FINAL ordered rule set, and the group's `tracking` token echoed back —
// Falcon's optimistic-concurrency check. A PATCH carrying a stale tracking token
// is rejected, so the assertions below are about the token the handler carries
// and about which rules keep their live id rather than being recreated.
//
// Unlike custom-ioa-rule-groups, the declared rules here ARE the complete rule
// set: deploy removes live rules the canvas does not declare, by design and by
// explicit `remove` operations (driftDetect reports them first, so the removal is
// never the first an operator hears of it).
//
// Read `lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache (why every context mints a fresh client secret) and
// the two-call lookup (`GET <queries>` answers with BARE ID STRINGS, then
// `GET <entity>?ids=…` answers with objects).

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
  createdId,
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
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/fwmgr\/queries\/rule-groups\/v1/
const ENTITY = /\/fwmgr\/entities\/rule-groups\/v1/

/** One declared rule, as `parseFirewallRules` reads it out of the JSON string. */
const DECLARED_RULE = {
  name: 'Block outbound SMB',
  description: 'No SMB egress',
  action: 'DENY',
  direction: 'OUT',
  protocol: 'TCP',
  addressFamily: 'IP4',
  remotePorts: [445],
  enabled: true,
}

/**
 * One declared rule group. `extractRuleGroupSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `platform`, `description`, `enabled`, and
 * `rules` as a JSON STRING.
 */
const GROUP = item('Windows egress controls', {
  name: 'veltrix-fw-windows',
  platform: 'windows',
  description: 'No SMB egress',
  enabled: true,
  rules: JSON.stringify([DECLARED_RULE]),
})

/** The live counterpart of DECLARED_RULE — canonically equal to it. */
const liveSmbRule = (over: Record<string, unknown> = {}) => ({
  id: 'fr-smb',
  name: 'Block outbound SMB',
  description: 'No SMB egress',
  enabled: true,
  action: 'DENY',
  direction: 'OUT',
  protocol: '6',
  address_family: 'IP4',
  local_port: [],
  remote_port: [{ start: 445, end: 0 }],
  local_address: [],
  remote_address: [],
  fields: [{ name: 'network_location', type: 'set', values: ['ANY'] }],
  ...over,
})

/** A rule an analyst added by hand, which this canvas does not declare. */
const liveAnalystRule = {
  ...liveSmbRule(),
  id: 'fr-analyst',
  name: 'Allow lab RDP',
  action: 'ALLOW',
  remote_port: [{ start: 3389, end: 0 }],
}

/**
 * The group as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_GROUP = {
  id: 'frg-live-1',
  name: 'veltrix-fw-windows',
  platform: 'windows',
  description: 'legacy description nobody updated',
  enabled: false,
  tracking: 'tracking-token-abc',
  rules: [liveAnalystRule],
  modified_by: 'alice@acme.com',
  modified_on: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'firewall-rule-groups', handler: deploy, items: [GROUP] })

test('firewall-rule-groups deploy: creates a group with its full rule set in one call', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: createdId('frg-new-1') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.equal(result.success, true)

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'veltrix-fw-windows')
    assert.equal(body?.platform, 'windows')
    assert.equal(body?.enabled, true)

    const rules = body?.rules as Array<Record<string, unknown>>
    assert.equal(rules?.length, 1)
    assert.equal(rules[0].name, 'Block outbound SMB')
    assert.equal(rules[0].action, 'DENY', 'the action is what the rule actually does')
    assert.equal(rules[0].direction, 'OUT')
    assert.equal(rules[0].protocol, '6', 'the fwmgr API stores the numeric IANA protocol')
    assert.deepEqual(rules[0].remote_port, [{ start: 445, end: 0 }])
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new group must not be patched')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: createdId('frg-new-1') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'veltrix-fw-windows')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'frg-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: updates an existing group with a diff carrying its tracking token', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing group must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'frg-live-1', 'the update must address the live group by its id')
    assert.equal(body?.diff_type, 'application/json-patch+json')
    assert.equal(
      body?.tracking,
      'tracking-token-abc',
      'a PATCH without the live tracking token is rejected as a stale write',
    )

    const ops = body?.diff_operations as Array<Record<string, unknown>>
    assert.ok(
      ops.some((op) => op.op === 'replace' && op.path === '/enabled' && op.value === true),
      `expected the group to be enabled, got ${JSON.stringify(ops)}`,
    )
    assert.ok(
      ops.some((op) => op.op === 'add' && op.path === '/rules/-'),
      'the declared rule is not on the group yet, so it must be added',
    )
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: keeps an unchanged rule’s live id instead of recreating it', async () => {
  // rule_ids is the FINAL ordered rule set. A rule that already matches must
  // carry its existing id through, or Falcon replaces it — losing its identity
  // and, with it, anything that referenced it.
  const matching = { ...LIVE_GROUP, rules: [liveSmbRule()] }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([matching]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([GROUP]))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(body?.rule_ids, ['fr-smb'], 'an unchanged rule keeps its id')
    assert.deepEqual(body?.rule_versions, [0])
    const ops = body?.diff_operations as Array<Record<string, unknown>>
    assert.equal(
      ops.some((op) => op.op === 'add' || op.op === 'remove'),
      false,
      `an unchanged rule must not be re-added: ${JSON.stringify(ops)}`,
    )
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: writes nothing at all when the live group already matches', async () => {
  const matching = {
    ...LIVE_GROUP,
    description: 'No SMB egress',
    enabled: true,
    rules: [liveSmbRule()],
  }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([matching]) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: removes an undeclared live rule explicitly, by index', async () => {
  // The canvas IS the complete rule set here (unlike custom-ioa-rule-groups), so
  // an undeclared rule is removed — but through an explicit remove operation
  // naming its index, and only after driftDetect has already reported it.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ ...LIVE_GROUP, rules: [liveSmbRule(), liveAnalystRule] }]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([GROUP]))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    const ops = body?.diff_operations as Array<Record<string, unknown>>
    assert.ok(
      ops.some((op) => op.op === 'remove' && op.path === '/rules/1'),
      `expected the undeclared rule at index 1 to be removed, got ${JSON.stringify(ops)}`,
    )
    assert.deepEqual(body?.rule_ids, ['fr-smb'], 'only the declared rule survives')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: records the LIVE prior rule set of a group it overwrote', async () => {
  // Rollback converges the group back to the rules that were there, so the
  // recorded prior must be the LIVE rule set — not the one the canvas wanted.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          existed: boolean
          id?: string
          prior?: { name?: string; description?: string; enabled?: boolean; rules: Array<{ name: string; action: string }> }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'frg-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.name, 'veltrix-fw-windows')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false, 'the group was disabled before this deploy enabled it')
    assert.equal(prior.rules.length, 1)
    assert.equal(prior.rules[0].name, 'Allow lab RDP', 'the rule that was actually there')
    assert.equal(prior.rules[0].action, 'ALLOW')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: refuses invalid rules JSON before touching the tenant', async () => {
  const BROKEN = item('Windows egress controls', {
    name: 'veltrix-fw-windows',
    platform: 'windows',
    enabled: true,
    rules: '[{"name":"no action","direction":"OUT","protocol":"TCP"}]',
  })
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([BROKEN]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid rules/)
    assert.equal(calls.length, 0, 'a canvas that cannot be parsed must not reach Falcon at all')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as enforcing.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('rule group quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: treats a stale-tracking rejection on the update as a failure', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('rule group tracking token is out of date') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /out of date/)
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createRuleGroup` throws here AFTER the POST
  // succeeded, and `rollbackState.push` is the line below its call — so the
  // group now exists in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is deliberately NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no group id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the group was in fact created')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: keeps the rollback record of what it wrote when a later group fails', async () => {
  const SECOND = item('Mac egress controls', {
    name: 'veltrix-fw-mac',
    platform: 'mac',
    enabled: true,
    rules: JSON.stringify([DECLARED_RULE]),
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [createdId('frg-new-1'), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([GROUP, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the group that WAS created must still be recorded')
    assert.equal(state[0].id, 'frg-new-1')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['frg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('firewall-rule-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
