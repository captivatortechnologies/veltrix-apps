// deploy for destination-profiles.
//
// A destination profile is a named set of network locations that policies match
// on. Beyond the shared contract: the canvas declares RBAC label NAMES and the
// API wants label ids, so an unresolvable label must fail the profile before the
// write rather than deploy it with its labels quietly dropped.

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

const BASE = '/profiles/destinations'
const BASE_RE = /\/profiles\/destinations/
const LABELS_RE = /\/rbac\/labels/

/** The RBAC labels the deploy resolves names against. Registered FIRST. */
const labelsRoute = { url: LABELS_RE, method: 'GET', respond: list([{ id: '33', name: 'prod' }]) } as const

const profile = (name: string) =>
  item(name, { name, type: 'regex', description: 'Managed by Veltrix', values: '10.0.0.0/8', labels: 'prod' })

/** The same profile as the TENANT holds it — a different match type and a
 *  different network range. */
const liveProfile = (name: string, id: string) => ({
  profile_id: id,
  name,
  type: 'insensitive',
  description: 'edited in the console',
  values: ['192.168.0.0/16'],
  label_ids: ['33'],
})

registerDeployGuardContract({
  label: 'destination-profiles',
  handler: deploy,
  items: [profile('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [labelsRoute],
})

registerCrudDeployContract({
  label: 'destination-profiles',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PATCH',
  item: profile,
  live: liveProfile,
  createdBody: (name, id) => ({ profile_id: id, name }),
  extraRoutes: [labelsRoute],
  assertPrior: (prior) => {
    assert.equal(prior.type, 'insensitive', 'the recorded prior must be the LIVE match type')
    assert.equal(prior.description, 'edited in the console')
    assert.deepEqual(prior.values, ['192.168.0.0/16'], 'the prior network set is what rollback restores')
    assert.deepEqual(prior.label_ids, ['33'])
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.type, 'regex')
    assert.deepEqual(body.values, ['10.0.0.0/8'])
    assert.deepEqual(body.label_ids, ['33'], 'the declared label NAME must reach the wire as its id')
  },
})

test('destination-profiles deploy: refuses a profile whose RBAC label does not exist, without writing it', async () => {
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ profile_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', type: 'regex', values: '10.0.0.0/8', labels: 'staging' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown RBAC label/)
    assert.match(String(result.message), /staging/)
    assert.equal(writeCalls(calls).length, 0, 'a profile must not be created with its labels silently dropped')
  } finally {
    restore()
  }
})

test('destination-profiles deploy: fails closed when the RBAC labels cannot be read', async () => {
  const { calls, restore } = routeFetch([
    { url: LABELS_RE, method: 'GET', respond: serverError('label service unavailable') },
    { url: BASE_RE, method: 'GET', respond: list([]) },
  ])
  try {
    const result = await deploy(deployContext([profile('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list RBAC labels/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('destination-profiles deploy: accepts a label declared by id as well as by name', async () => {
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ profile_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', type: 'regex', values: '10.0.0.0/8', labels: '33' })]),
    )

    assert.equal(result.success, true, result.message)
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.label_ids, ['33'])
  } finally {
    restore()
  }
})

test('destination-profiles deploy: sends an empty label list rather than omitting it', async () => {
  // Omitting label_ids on an update would leave whatever labels the tenant has,
  // so a profile could never have its labels removed through the canvas.
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: list([liveProfile('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PATCH', respond: ok({ profile_id: '4102' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', type: 'regex', values: '10.0.0.0/8' })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.label_ids, [])
  } finally {
    restore()
  }
})

test('destination-profiles deploy: defaults the match type to insensitive rather than leaving it blank', async () => {
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ profile_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', values: 'acme.test' })]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.type, 'insensitive')
  } finally {
    restore()
  }
})
