// deploy for firewall-policies.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is that a firewall policy is SPLIT across two collections and
// this handler wires them together:
//
//   the SHELL     /policy/entities/firewall/v1  — name, description, platform,
//                 and (through `firewall-actions`) enablement + host groups
//   the CONTAINER /fwmgr/entities/policies/v2   — rule-group assignment (ordered,
//                 because order is precedence), default in/out actions, enforce,
//                 test mode, local logging
//
// A test that only read the shell write would miss every setting that decides
// what the firewall actually does. The live fixtures below differ from the
// canvas in every managed field of BOTH collections.

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
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  serverError,
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const COMBINED = /\/policy\/combined\/firewall\/v1/
const ACTIONS = /\/policy\/entities\/firewall-actions\/v1/
const ENTITY = /\/policy\/entities\/firewall\/v1/
const FWMGR_GET = /\/fwmgr\/entities\/policies\/v1/
const FWMGR_PUT = /\/fwmgr\/entities\/policies\/v2/

/**
 * Falcon wraps every /policy write in `{ resources: [ … ] }`. The fwmgr
 * container PUT does NOT — it takes a bare object. Defined locally because the
 * shared fake has no envelope helper and must not be edited.
 */
function resource(call: RecordedCall | undefined): Record<string, unknown> | null {
  const list = bodyOf(call)?.resources
  return Array.isArray(list) ? ((list[0] as Record<string, unknown>) ?? null) : null
}

function actionCalls(calls: RecordedCall[], name: string): RecordedCall[] {
  return calls.filter((c) => c.url.includes('firewall-actions') && c.url.includes(`action_name=${name}`))
}

/**
 * One declared firewall policy. `extractFirewallPolicySpecs` reads a FLAT
 * `fields` record — `name`, `platform`, `description`, `enabled`, `hostGroups`
 * for the shell, and `ruleGroups`, `defaultInbound`, `defaultOutbound`,
 * `enforce`, `localLogging`, `testMode` for the fwmgr container.
 */
const POLICY = item('Windows firewall', {
  name: 'Corp Windows Firewall',
  platform: 'Windows',
  description: 'Deny inbound, allow outbound',
  enabled: true,
  hostGroups: 'hg-workstations, hg-laptops',
  ruleGroups: 'rg-core, rg-rdp',
  defaultInbound: 'DENY',
  defaultOutbound: 'ALLOW',
  enforce: true,
  localLogging: true,
  testMode: false,
})

/** The policy shell as it exists in the tenant BEFORE this deploy. */
const LIVE_SHELL = {
  id: 'pol-live-1',
  name: 'Corp Windows Firewall',
  platform_name: 'Windows',
  description: 'legacy description nobody updated',
  enabled: false,
  groups: [{ id: 'hg-servers', name: 'Servers' }],
}

/** Its fwmgr container — inverted against the canvas in every managed field. */
const LIVE_CONTAINER = {
  policy_id: 'pol-live-1',
  platform_id: '0',
  rule_group_ids: ['rg-legacy'],
  default_inbound: 'ALLOW',
  default_outbound: 'DENY',
  enforce: false,
  test_mode: true,
  local_logging: false,
  tracking: 'track-before-deploy',
}

registerDeployGuardContract({ label: 'firewall-policies', handler: deploy, items: [POLICY] })

test('firewall-policies deploy: creates the shell of a policy that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0', tracking: 'track-new' }]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assertAuthenticatedFirst(assert, calls)
    assert.equal(result.success, true)

    const creates = callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('firewall-actions'))
    assert.equal(creates.length, 1, `expected exactly one create, got ${describeCalls(creates)}`)
    const body = resource(creates[0])
    assert.equal(body?.name, 'Corp Windows Firewall')
    assert.equal(body?.platform_name, 'Windows')
    assert.equal(body?.description, 'Deny inbound, allow outbound')
    assert.equal(body?.enabled, undefined, 'enablement is not a create-body field')
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a policy that did not exist must not be patched')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: writes the rule groups and defaults to the fwmgr container, not the shell', async () => {
  // Everything that decides what the firewall does lives on the container. A
  // deploy that wrote only the shell would leave the tenant's old rule set in
  // place while reporting the policy deployed.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0', tracking: 'track-new' }]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const puts = callsOfMethod(calls, 'PUT')
    assert.equal(puts.length, 1, `expected exactly one container write, got ${describeCalls(puts)}`)
    const body = bodyOf(puts[0])
    assert.equal(body?.policy_id, 'pol-new-1')
    assert.equal(body?.platform_id, '0')
    assert.deepEqual(body?.rule_group_ids, ['rg-core', 'rg-rdp'], 'rule-group ORDER is precedence')
    assert.equal(body?.default_inbound, 'DENY')
    assert.equal(body?.default_outbound, 'ALLOW')
    assert.equal(body?.enforce, true)
    assert.equal(body?.test_mode, false)
    assert.equal(body?.local_logging, true)
    assert.equal(body?.tracking, 'track-new', 'the container PUT echoes the concurrency token it read')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: falls back to the platform id when the container reports none', async () => {
  // A container that came back without a platform_id would otherwise be written
  // with `platform_id: undefined`, which the fwmgr service rejects.
  const LINUX = item('Linux firewall', {
    name: 'Corp Linux Firewall',
    platform: 'Linux',
    enabled: false,
    defaultInbound: 'DENY',
    defaultOutbound: 'ALLOW',
  })
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: EMPTY },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-2' }) },
  ])
  try {
    await deploy(deployContext([LINUX]))

    const body = bodyOf(callsOfMethod(calls, 'PUT')[0])
    assert.equal(body?.platform_id, '3', 'Linux is platform_id 3 on the fwmgr container')
    assert.equal(body?.tracking, undefined, 'no token was read, so none is echoed')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: creates the policy DISABLED and enables it through an actions call', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0' }]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const enables = actionCalls(calls, 'enable')
    assert.equal(enables.length, 1, `expected exactly one enable action, got ${describeCalls(enables)}`)
    assert.deepEqual(bodyOf(enables[0])?.ids, ['pol-new-1'])
    assert.equal(actionCalls(calls, 'disable').length, 0)
  } finally {
    restore()
  }
})

test('firewall-policies deploy: attaches the declared host groups through actions calls', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0' }]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const attaches = actionCalls(calls, 'add-host-group')
    assert.equal(attaches.length, 2, `expected two attaches, got ${describeCalls(attaches)}`)
    assert.deepEqual(bodyOf(attaches[0])?.action_parameters, [
      { name: 'group_id', value: 'hg-workstations' },
    ])
    assert.deepEqual(bodyOf(attaches[1])?.action_parameters, [{ name: 'group_id', value: 'hg-laptops' }])
    assert.equal(actionCalls(calls, 'remove-host-group').length, 0, 'a new policy has nothing to detach')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: records the created policy so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0' }]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'Corp Windows Firewall')
    assert.equal(state[0].platform, 'Windows')
    assert.equal(state[0].existed, false, 'a policy this deploy created is not pre-existing')
    assert.equal(state[0].id, 'pol-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: keeps the created policy recorded when the container write then fails', async () => {
  // The shell exists in the tenant the moment the POST returns. If the fwmgr
  // write fails afterwards, rollback still has to be able to remove it.
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0' }]) },
    { url: FWMGR_PUT, respond: forbidden('access denied, authorization failed') },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pol-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state[0].id, 'pol-new-1')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: updates a policy that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('firewall-actions')).length,
      0,
      'an existing policy must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one shell update, got ${describeCalls(patches)}`)
    const body = resource(patches[0])
    assert.equal(body?.id, 'pol-live-1', 'the update must address the live policy by its id')
    assert.equal(body?.name, 'Corp Windows Firewall')
    assert.equal(body?.description, 'Deny inbound, allow outbound')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: overwrites the container of an existing policy, keeping its tracking token', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const body = bodyOf(callsOfMethod(calls, 'PUT')[0])
    assert.equal(body?.policy_id, 'pol-live-1')
    assert.deepEqual(body?.rule_group_ids, ['rg-core', 'rg-rdp'])
    assert.equal(body?.default_inbound, 'DENY')
    assert.equal(body?.default_outbound, 'ALLOW')
    assert.equal(body?.enforce, true)
    assert.equal(body?.test_mode, false)
    assert.equal(body?.local_logging, true)
    assert.equal(body?.tracking, 'track-before-deploy')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: reads the prior container BEFORE it overwrites anything', async () => {
  // Rollback can only restore a container that was read before the PUT replaced
  // it. Reading it afterwards would record what the deploy itself just wrote.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const containerRead = calls.findIndex((c) => c.url.includes('/fwmgr/entities/policies/v1'))
    const firstWrite = calls.findIndex((c) => c.method !== 'GET' && !c.url.includes('/oauth2/token'))
    assert.ok(containerRead >= 0, 'the prior container was never read')
    assert.ok(containerRead < firstWrite, 'the container was read only after the first write')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: records the LIVE prior shell and container values it overwrote', async () => {
  // The canvas asks for enabled / DENY-in / ALLOW-out / enforce; the tenant
  // holds disabled / ALLOW-in / DENY-out / monitor-only. Rollback restores what
  // was there, not what was wanted.
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          existed: boolean
          id?: string
          prior?: { description?: string; enabled?: boolean; container?: Record<string, unknown> }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'pol-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.enabled, false)

    const container = prior.container
    assert.ok(container, 'an update with no recorded container cannot restore the firewall itself')
    assert.equal(container.platform_id, '0')
    assert.deepEqual(container.rule_group_ids, ['rg-legacy'])
    assert.equal(container.default_inbound, 'ALLOW')
    assert.equal(container.default_outbound, 'DENY')
    assert.equal(container.enforce, false)
    assert.equal(container.test_mode, true)
    assert.equal(container.local_logging, false)
  } finally {
    restore()
  }
})

test('firewall-policies deploy: converges host groups and records the deltas it applied', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.deepEqual(
      actionCalls(calls, 'add-host-group').map((c) => bodyOf(c)?.action_parameters),
      [
        [{ name: 'group_id', value: 'hg-workstations' }],
        [{ name: 'group_id', value: 'hg-laptops' }],
      ],
    )
    assert.deepEqual(
      actionCalls(calls, 'remove-host-group').map((c) => bodyOf(c)?.action_parameters),
      [[{ name: 'group_id', value: 'hg-servers' }]],
    )

    const prior = (
      result.rollbackData as {
        previousState?: Array<{ prior?: { groupsAdded: string[]; groupsRemoved: string[] } }>
      }
    )?.previousState?.[0].prior
    assert.deepEqual(prior?.groupsAdded, ['hg-workstations', 'hg-laptops'])
    assert.deepEqual(prior?.groupsRemoved, ['hg-servers'])
  } finally {
    restore()
  }
})

test('firewall-policies deploy: converges enablement on an existing policy it found disabled', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([POLICY]))

    const enables = actionCalls(calls, 'enable')
    assert.equal(enables.length, 1, `expected exactly one enable, got ${describeCalls(enables)}`)
    assert.deepEqual(bodyOf(enables[0])?.ids, ['pol-live-1'])
  } finally {
    restore()
  }
})

test('firewall-policies deploy: stops rather than overwriting when the prior container cannot be read', async () => {
  // A 500 on the container read is "I could not see what is there". Proceeding
  // would replace the tenant's live rule set with nothing recorded to put back.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: FWMGR_GET, respond: serverError('internal server error') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /container/i)
    assert.equal(callsOfMethod(calls, 'PUT').length, 0, 'the container must not be written unread')
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'the shell must not be written either')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('firewall-policies deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a policy it never created as deployed.
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('firewall policy quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('firewall-policies deploy: treats a 200-with-errors on the container PUT as a failure', async () => {
  // The shell was written but the rule groups never landed. Reporting success
  // here tells an operator the firewall is enforcing rules it never received.
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: partialFailure('unknown rule group id') },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown rule group id/)
  } finally {
    restore()
  }
})

test('firewall-policies deploy: keeps the rollback record of what it wrote when a later policy fails', async () => {
  const SECOND = item('Mac firewall', {
    name: 'Corp Mac Firewall',
    platform: 'Mac',
    enabled: false,
    defaultInbound: 'DENY',
    defaultOutbound: 'ALLOW',
  })
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([{ policy_id: 'pol-new-1', platform_id: '0' }]) },
    { url: FWMGR_PUT, respond: ok() },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'pol-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([POLICY, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the policy that WAS created must still be recorded')
    assert.equal(state[0].id, 'pol-new-1')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createShell` raises the missing-id error
  // BEFORE deploy pushes the rollback entry, so the policy shell now exists in
  // the tenant with nothing recorded to delete it — unlike the other five policy
  // families, which record the entry first. What is asserted here is only the
  // half that is certainly right: the deploy does not claim success, and the
  // shell really was created. The rollback record it fails to keep is NOT
  // asserted.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no policy id/i)
    assert.equal(
      callsOfMethod(calls, 'POST').filter((c) => !c.url.includes('firewall-actions')).length,
      1,
      'the policy shell was in fact created',
    )
  } finally {
    restore()
  }
})

test('firewall-policies deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_SHELL]) },
    { url: ACTIONS, respond: ok() },
    { url: FWMGR_GET, respond: entityPage([LIVE_CONTAINER]) },
    { url: FWMGR_PUT, respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([POLICY]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('firewall-policies deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
