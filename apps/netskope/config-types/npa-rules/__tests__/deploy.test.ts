// deploy for npa-rules.
//
// An NPA rule is the object that decides who reaches which private app, so this
// is the most consequential write in the app. Three things beyond the shared
// contract matter:
//
//   * POLICY GROUP RESOLUTION. The canvas declares a group NAME; the API wants
//     group_id. An unknown group must fail the rule before the write, not put an
//     allow rule into whatever group the API happens to pick.
//   * THE FULL-REPLACE UPDATE. `rule_data` is sent whole, so every criterion has
//     to be in it or the update silently drops the criterion.
//   * THE EVENTUAL-CONSISTENCY RETRY. A rule that references an app created
//     earlier in the same pipeline can fail once and succeed on retry.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  badRequest,
  bodyOf,
  deployContext,
  item,
  npaData,
  npaList,
  ok,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/policy/npa/rules'
const BASE_RE = /\/policy\/npa\/rules/
const GROUPS_RE = /\/policy\/npa\/policygroups/

/** The policy groups the deploy resolves names against. Registered FIRST. */
const groupsRoute = {
  url: GROUPS_RE,
  method: 'GET',
  respond: npaList('policy_groups', [{ id: '55', group_name: 'Corporate' }]),
} as const

const rule = (name: string) =>
  item(name, {
    rule_name: name,
    description: 'Managed by Veltrix',
    enabled: true,
    group: 'Corporate',
    action: 'allow',
    private_apps: 'CRM',
    users: 'alice@acme.test',
    access_method: 'Client',
  })

/** The same rule as the TENANT holds it — DISABLED, and blocking a different app
 *  set, so a prior rebuilt from the canvas is caught. */
const liveRule = (name: string, id: string) => ({
  rule_id: id,
  rule_name: name,
  description: 'edited in the console',
  enabled: '0',
  group_id: '55',
  rule_data: {
    policy_type: 'private-app',
    match_criteria_action: { action_name: 'block' },
    private_apps: ['[LegacyApp]'],
    users: ['bob@acme.test'],
    access_method: ['Clientless'],
    json_version: 3,
  },
})

registerDeployGuardContract({
  label: 'npa-rules',
  handler: deploy,
  items: [rule('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [groupsRoute],
})

registerCrudDeployContract({
  label: 'npa-rules',
  handler: deploy,
  basePath: BASE,
  listKey: 'rules',
  createEnvelope: 'npa',
  updateMethod: 'PUT',
  item: rule,
  live: liveRule,
  createdBody: (name, id) => ({ rule_id: id, rule_name: name }),
  extraRoutes: [groupsRoute],
  assertPrior: (prior) => {
    assert.equal(prior.enabled, '0', 'a rule that was disabled must roll back to disabled')
    assert.equal(prior.description, 'edited in the console')
    const data = prior.rule_data as Record<string, unknown>
    assert.deepEqual(data.match_criteria_action, { action_name: 'block' }, 'the prior ACTION is what rollback restores')
    assert.deepEqual(data.private_apps, ['[LegacyApp]'])
    assert.deepEqual(data.users, ['bob@acme.test'])
  },
  assertCreateBody: (body) => {
    assert.equal(body.rule_name, 'veltrix-alpha')
    assert.equal(body.enabled, '1', 'Netskope wants the enabled flag as "1"/"0", not a boolean')
    assert.equal(body.group_id, '55', 'the declared group name must reach the wire as its id')
    const data = body.rule_data as Record<string, unknown>
    assert.equal(data.policy_type, 'private-app')
    assert.deepEqual(data.match_criteria_action, { action_name: 'allow' })
    assert.deepEqual(data.private_apps, ['CRM'])
    assert.deepEqual(data.users, ['alice@acme.test'])
    assert.equal(data.json_version, 3)
  },
})

test('npa-rules deploy: refuses a rule whose policy group does not exist, without writing it', async () => {
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ rule_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { rule_name: 'veltrix-alpha', group: 'Nonexistent', action: 'allow' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown policy group/)
    assert.equal(writeCalls(calls).length, 0, 'an access rule must never land in an unintended group')
  } finally {
    restore()
  }
})

test('npa-rules deploy: fails closed when the policy groups cannot be read', async () => {
  const { calls, restore } = routeFetch([
    { url: GROUPS_RE, method: 'GET', respond: serverError('policy service unavailable') },
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
  ])
  try {
    const result = await deploy(deployContext([rule('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list NPA policy groups/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('npa-rules deploy: accepts a policy group declared by id as well as by name', async () => {
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ rule_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { rule_name: 'veltrix-alpha', group: '55', action: 'block' })]),
    )

    assert.equal(result.success, true, result.message)
    assert.equal(bodyOf(writeCalls(calls)[0])?.group_id, '55')
  } finally {
    restore()
  }
})

test('npa-rules deploy: omits group_id entirely when the canvas declares no group', async () => {
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ rule_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { rule_name: 'veltrix-alpha', action: 'allow' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('group_id' in body, false)
  } finally {
    restore()
  }
})

test('npa-rules deploy: sends enabled "0" for a rule the canvas turns off', async () => {
  // A rule left enabled when the canvas disabled it keeps granting access.
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ rule_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('veltrix-alpha', { rule_name: 'veltrix-alpha', enabled: false, group: 'Corporate', action: 'allow' })]),
    )

    assert.equal(bodyOf(writeCalls(calls)[0])?.enabled, '0')
  } finally {
    restore()
  }
})

test('npa-rules deploy: retries a create that failed because a referenced app is not resolvable yet', async () => {
  // Rule creation is eventually consistent with the private app the same
  // pipeline just created. One retry is the difference between a rule that
  // exists and one the operator has to create by hand.
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
    {
      url: BASE_RE,
      method: 'POST',
      respond: [badRequest('private app does not exist'), npaData({ rule_id: '9001' })],
    },
  ])
  try {
    const result = await deploy(deployContext([rule('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.equal(writeCalls(calls).length, 2, 'the create is attempted twice')
    const entries = (result.rollbackData as { entries: Array<{ id?: string }> }).entries
    assert.equal(entries[0].id, '9001', 'the retried create is still recorded')
  } finally {
    restore()
  }
})

test('npa-rules deploy: does not retry a create rejected for an unrelated reason', async () => {
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', []) },
    { url: BASE_RE, method: 'POST', respond: badRequest('rule name already in use') },
  ])
  try {
    const result = await deploy(deployContext([rule('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 1, 'a duplicate-name rejection is final, not a consistency wobble')
  } finally {
    restore()
  }
})

test('npa-rules deploy: matches a rule the tenant keys under `id`', async () => {
  const { calls, restore } = routeFetch([
    groupsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('rules', [{ id: '4102', rule_name: 'veltrix-alpha' }]) },
    { url: BASE_RE, method: 'PUT', respond: ok({ rule_id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([rule('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.match(writeCalls(calls)[0].url, /\/policy\/npa\/rules\/4102$/)
  } finally {
    restore()
  }
})
