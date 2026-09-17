// deploy for aig-token-groups.
//
// This config type manages the token GROUP container, never the per-token
// secrets, so there is nothing secret in the body. The shared contracts cover
// the refusals, the create/update split and the prior state recorded for an
// update; what is specific here is that a blank description is omitted rather
// than sent as an empty string.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import { bodyOf, created, deployContext, item, list, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/aig/tokengroups'
const BASE_RE = /\/aig\/tokengroups/

const group = (name: string) => item(name, { name, description: 'Managed by Veltrix' })

/** The same group as the TENANT holds it — a hand-edited description. */
const liveGroup = (name: string, id: string) => ({ id, name, description: 'edited in the console' })

registerDeployGuardContract({
  label: 'aig-token-groups',
  handler: deploy,
  items: [group('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'aig-token-groups',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PUT',
  item: group,
  live: liveGroup,
  createdBody: (name, id) => ({ id, name }),
  assertPrior: (prior) => {
    assert.equal(prior.name, 'veltrix-alpha')
    assert.equal(
      prior.description,
      'edited in the console',
      'the recorded prior must be the LIVE description, not the one being written',
    )
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.description, 'Managed by Veltrix')
  },
})

test('aig-token-groups deploy: omits description entirely when none is declared', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    const result = await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha' })]))

    assert.equal(result.success, true, result.message)
    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal('description' in body, false, 'a blank description must be omitted, not sent as ""')
  } finally {
    restore()
  }
})

test('aig-token-groups deploy: accepts a group whose id the tenant returns as group_id', async () => {
  // Netskope answers this collection with `id` on some tenants and `group_id` on
  // others; matching on only one of them would create a duplicate group.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ group_id: '4102', name: 'veltrix-alpha', description: 'x' }]) },
    { url: BASE_RE, method: 'PUT', respond: { status: 200, body: { group_id: '4102' } } },
  ])
  try {
    const result = await deploy(deployContext([group('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PUT')
    assert.match(writes[0].url, /\/aig\/tokengroups\/4102$/)
  } finally {
    restore()
  }
})
