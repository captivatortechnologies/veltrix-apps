// deploy for npa-policy-groups.
//
// A policy group is a named container for NPA rules, so its name IS its whole
// managed state. Two things are specific to this config type:
//
//   * Netskope ships BUILT-IN groups (`can_be_edited_deleted: false`). They must
//     be recorded as matched and left alone — a rename would be rejected, and a
//     delete would take every rule in them out of the policy.
//   * A group whose live name already equals the declared one needs no write at
//     all, so the deploy is a no-op that still records the match.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  deployContext,
  item,
  npaData,
  npaList,
  ok,
  priorDeployment,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/policy/npa/policygroups'
const BASE_RE = /\/policy\/npa\/policygroups/

const group = (name: string) => item(name, { group_name: name })

/** The same group as the TENANT holds it — the name differs only in case, which
 *  is how this config type's update path is reachable at all. */
const liveGroup = (name: string, id: string) => ({
  id,
  group_name: name.toUpperCase(),
  can_be_edited_deleted: true,
  group_type: 'custom',
})

registerDeployGuardContract({
  label: 'npa-policy-groups',
  handler: deploy,
  items: [group('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'npa-policy-groups',
  handler: deploy,
  basePath: BASE,
  listKey: 'policy_groups',
  createEnvelope: 'npa',
  updateMethod: 'PUT',
  item: group,
  live: liveGroup,
  createdBody: (name, id) => ({ id, group_name: name }),
  assertPrior: (prior) => {
    assert.equal(
      prior.name,
      'VELTRIX-ALPHA',
      'the recorded prior must be the LIVE group name, not the one being written',
    )
  },
  assertCreateBody: (body) => {
    assert.equal(body.group_name, 'veltrix-alpha')
  },
})

test('npa-policy-groups deploy: writes nothing when the live name already matches, but still records the match', async () => {
  const { calls, restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('policy_groups', [{ id: '4102', group_name: 'veltrix-alpha', can_be_edited_deleted: true }]),
    },
  ])
  try {
    const result = await deploy(deployContext([group('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.equal(writeCalls(calls).length, 0, 'a group already in the wanted state needs no write')
    const entries = (result.rollbackData as { entries: Array<{ id?: string; existed?: boolean }> }).entries
    assert.equal(entries.length, 1, 'the match must still be recorded so a later rollback can find the group')
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, '4102')
  } finally {
    restore()
  }
})

test('npa-policy-groups deploy: never renames a built-in group', async () => {
  // `can_be_edited_deleted: false` marks a Netskope-managed group. Renaming it
  // would be rejected by the API; deleting it would orphan every rule inside.
  const { calls, restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('policy_groups', [{ id: '1', group_name: 'DEFAULT', can_be_edited_deleted: false }]),
    },
  ])
  try {
    const result = await deploy(deployContext([item('Default', { group_name: 'Default' })]))

    assert.equal(result.success, true, result.message)
    assert.equal(writeCalls(calls).length, 0, 'a built-in group is preserved as-is')
    const entries = (result.rollbackData as { entries: Array<{ id?: string }> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, '1')
  } finally {
    restore()
  }
})

test('npa-policy-groups deploy: treats can_be_edited_deleted returned as the string "false" as built-in', async () => {
  // Some tenants serialise the flag as a string. Reading only the boolean would
  // let the handler rename a Netskope-managed group.
  const { calls, restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('policy_groups', [{ id: '1', group_name: 'DEFAULT', can_be_edited_deleted: 'false' }]),
    },
  ])
  try {
    await deploy(deployContext([item('Default', { group_name: 'Default' })]))

    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('npa-policy-groups deploy: renames a custom group whose live name differs', async () => {
  const { calls, restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('policy_groups', [{ id: '4102', group_name: 'veltrix-ALPHA', can_be_edited_deleted: true }]),
    },
    { url: BASE_RE, method: 'PUT', respond: ok({ id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([group('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, `${BASE_URL}${BASE}/4102`)
    assert.deepEqual(bodyOf(writes[0]), { group_name: 'veltrix-alpha' })
  } finally {
    restore()
  }
})

test('npa-policy-groups deploy: deletes a group it created previously and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('policy_groups', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ id: '9001' }) },
    { url: BASE_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([group('veltrix-alpha')], {
        latestDeployment: priorDeployment([{ name: 'veltrix-retired', existed: false, id: '7777' }]),
      }),
    )

    assert.equal(result.success, true, result.message)
    const deletes = writeCalls(calls).filter((x) => x.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0].url, `${BASE_URL}${BASE}/7777`)
  } finally {
    restore()
  }
})
