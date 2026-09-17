// deploy for publisher-upgrade-profiles.
//
// An upgrade profile decides WHEN a fleet of publishers restarts and WHICH build
// it takes, so the release channel, the docker tag and the enabled flag are the
// fields that matter. The shared contracts cover the refusals, the create/update
// split and the prior state recorded for an update; what is specific here is the
// optional timezone id, which is omitted rather than sent as 0.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import { bodyOf, deployContext, item, npaData, npaList, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/infrastructure/publisherupgradeprofiles'
const BASE_RE = /\/infrastructure\/publisherupgradeprofiles/

const profile = (name: string) =>
  item(name, {
    name,
    docker_tag: '2.1.0',
    release_type: 'Latest',
    enabled: true,
    frequency: '0 2 * * SUN',
    timezone: 'US/Pacific',
    timezone_id: 7,
  })

/** The same profile as the TENANT holds it — a Beta channel on an older build,
 *  currently disabled, on a different schedule. */
const liveProfile = (name: string, id: string) => ({
  external_id: id,
  name,
  docker_tag: '1.9.0',
  release_type: 'Beta',
  enabled: false,
  frequency: '30 4 * * MON',
  timezone: 'UTC',
  timezone_id: 1,
})

registerDeployGuardContract({
  label: 'publisher-upgrade-profiles',
  handler: deploy,
  items: [profile('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'publisher-upgrade-profiles',
  handler: deploy,
  basePath: BASE,
  listKey: 'upgrade_profiles',
  createEnvelope: 'npa',
  updateMethod: 'PUT',
  item: profile,
  live: liveProfile,
  createdBody: (name, id) => ({ external_id: id, name }),
  assertPrior: (prior) => {
    assert.equal(prior.docker_tag, '1.9.0', 'the recorded prior must be the LIVE build')
    assert.equal(prior.release_type, 'Beta')
    assert.equal(prior.enabled, false, 'a profile that was disabled must roll back to disabled')
    assert.equal(prior.frequency, '30 4 * * MON')
    assert.equal(prior.timezone_id, 1)
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.docker_tag, '2.1.0')
    assert.equal(body.release_type, 'Latest')
    assert.equal(body.enabled, true)
    assert.equal(body.frequency, '0 2 * * SUN')
    assert.equal(body.timezone, 'US/Pacific')
    assert.equal(body.timezone_id, 7)
  },
})

test('publisher-upgrade-profiles deploy: omits timezone_id when the canvas leaves it unset', async () => {
  // 0 is "not set" in the canvas, and sending it would be read as a real
  // timezone id by the API.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('upgrade_profiles', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ external_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([
        item('veltrix-alpha', { name: 'veltrix-alpha', docker_tag: '2.1.0', frequency: '0 2 * * SUN', timezone: 'UTC' }),
      ]),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('timezone_id' in body, false)
    assert.equal(body.release_type, 'Latest', 'the release channel defaults to Latest, never to blank')
    assert.equal(body.enabled, true, 'a profile is enabled unless the canvas explicitly turns it off')
  } finally {
    restore()
  }
})

test('publisher-upgrade-profiles deploy: matches a profile the tenant keys under publisher_upgrade_profile_id', async () => {
  const { calls, restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('upgrade_profiles', [{ publisher_upgrade_profile_id: '4102', name: 'veltrix-alpha' }]),
    },
    { url: BASE_RE, method: 'PUT', respond: { status: 200, body: { status: 'success' } } },
  ])
  try {
    const result = await deploy(deployContext([profile('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.match(writes[0].url, /publisherupgradeprofiles\/4102$/)
  } finally {
    restore()
  }
})
