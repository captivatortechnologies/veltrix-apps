// deploy for custom-categories.
//
// A custom category groups URL lists, destination profiles and predefined
// Netskope categories under one name for policies to match on, so its deploy
// resolves TWO other collections before it writes. Beyond the shared contract:
// an unresolvable reference must fail the category before the write, and BOTH
// reference listings must fail closed — a category deployed with a silently
// empty URL-list set matches nothing, which reads to a policy as "allow".

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  created,
  deployContext,
  item,
  list,
  ok,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/profiles/customcategories'
const BASE_RE = /\/profiles\/customcategories/
const URL_LISTS_RE = /\/policy\/urllist/
const DEST_PROFILES_RE = /\/profiles\/destinations/

/** The two collections the deploy resolves names against. Registered FIRST. */
const referenceRoutes = [
  { url: URL_LISTS_RE, method: 'GET', respond: list([{ id: '11', name: 'blocked-sites' }]) },
  { url: DEST_PROFILES_RE, method: 'GET', respond: list([{ profile_id: '22', name: 'branch-networks' }]) },
] as const

const category = (name: string) =>
  item(name, {
    name,
    description: 'Managed by Veltrix',
    included_predefined_categories: '500',
    included_url_lists: 'blocked-sites',
    excluded_url_lists: '',
    included_destination_profiles: 'branch-networks',
    excluded_destination_profiles: '',
  })

/** The same category as the TENANT holds it — a different predefined set and no
 *  destination profile, so a prior rebuilt from the canvas is caught. */
const liveCategory = (name: string, id: string) => ({
  id,
  name,
  description: 'edited in the console',
  included_predefined_categories: ['600', '601'],
  included_url_lists: ['11'],
  excluded_url_lists: [],
  included_destination_profiles: [],
  excluded_destination_profiles: [],
})

registerDeployGuardContract({
  label: 'custom-categories',
  handler: deploy,
  items: [category('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [...referenceRoutes],
})

registerCrudDeployContract({
  label: 'custom-categories',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PATCH',
  item: category,
  live: liveCategory,
  createdBody: (name, id) => ({ id, name }),
  extraRoutes: [...referenceRoutes],
  assertPrior: (prior) => {
    assert.equal(prior.description, 'edited in the console', 'the recorded prior must be the LIVE description')
    assert.deepEqual(prior.included_predefined_categories, ['600', '601'], 'the prior predefined set is what rollback restores')
    assert.deepEqual(prior.included_destination_profiles, [])
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.deepEqual(body.included_predefined_categories, ['500'])
    assert.deepEqual(body.included_url_lists, ['11'], 'the declared URL-list NAME must reach the wire as its id')
    assert.deepEqual(body.included_destination_profiles, ['22'])
    assert.deepEqual(body.excluded_url_lists, [])
  },
})

test('custom-categories deploy: refuses a category referencing a URL list that does not exist', async () => {
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', included_url_lists: 'no-such-list' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown URL list \/ destination profile/)
    assert.match(String(result.message), /no-such-list/)
    assert.equal(writeCalls(calls).length, 0, 'a category that matches nothing is worse than no category')
  } finally {
    restore()
  }
})

test('custom-categories deploy: refuses a category referencing a destination profile that does not exist', async () => {
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', excluded_destination_profiles: 'no-such-profile' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /no-such-profile/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('custom-categories deploy: fails closed when the URL lists cannot be read', async () => {
  const { calls, restore } = routeFetch([
    { url: URL_LISTS_RE, method: 'GET', respond: serverError('url list service unavailable') },
    referenceRoutes[1],
    { url: BASE_RE, method: 'GET', respond: list([]) },
  ])
  try {
    const result = await deploy(deployContext([category('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list URL lists/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('custom-categories deploy: fails closed when the destination profiles cannot be read', async () => {
  const { calls, restore } = routeFetch([
    referenceRoutes[0],
    { url: DEST_PROFILES_RE, method: 'GET', respond: serverError('profile service unavailable') },
    { url: BASE_RE, method: 'GET', respond: list([]) },
  ])
  try {
    const result = await deploy(deployContext([category('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list destination profiles/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('custom-categories deploy: accepts a reference declared by id as well as by name', async () => {
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', included_url_lists: '11', excluded_destination_profiles: '22' })]),
    )

    assert.equal(result.success, true, result.message)
    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(body.included_url_lists, ['11'])
    assert.deepEqual(body.excluded_destination_profiles, ['22'])
  } finally {
    restore()
  }
})

test('custom-categories deploy: sends every reference list, empty ones included', async () => {
  // Omitting an emptied list on an update would leave the tenant's existing
  // members in place, so a category could never be narrowed through the canvas.
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([liveCategory('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PATCH', respond: ok({ id: '4102' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(body.included_predefined_categories, [])
    assert.deepEqual(body.included_url_lists, [])
    assert.deepEqual(body.excluded_url_lists, [])
    assert.deepEqual(body.included_destination_profiles, [])
    assert.deepEqual(body.excluded_destination_profiles, [])
  } finally {
    restore()
  }
})
