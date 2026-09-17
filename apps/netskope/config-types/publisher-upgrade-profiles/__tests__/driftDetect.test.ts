// driftDetect for publisher-upgrade-profiles.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the release channel, the
// pinned build and the enabled flag — the three that decide what a publisher
// fleet upgrades to and when.
//
// NOTE: `frequency` and `timezone` are deliberately not asserted. The handler
// does not diff them, so an upgrade window moved in the console reports as in
// sync — see the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/infrastructure\/publisherupgradeprofiles/
const PROFILE = item('veltrix-alpha', {
  name: 'veltrix-alpha',
  docker_tag: '2.1.0',
  release_type: 'Latest',
  enabled: true,
  frequency: '0 2 * * SUN',
  timezone: 'US/Pacific',
})

registerDriftContract({
  label: 'publisher-upgrade-profiles',
  handler: driftDetect,
  basePath: '/infrastructure/publisherupgradeprofiles',
  listKey: 'upgrade_profiles',
  items: [PROFILE],
  inSync: [{ external_id: '4102', name: 'veltrix-alpha', docker_tag: '2.1.0', release_type: 'Latest', enabled: true }],
  missingField: 'veltrix-alpha',
})

test('publisher-upgrade-profiles driftDetect: reports a fleet switched to the Beta channel', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('upgrade_profiles', [
        { external_id: '4102', name: 'veltrix-alpha', docker_tag: '1.9.0', release_type: 'Beta', enabled: true },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    assert.equal(result.hasDrift, true)
    const fields = result.diffs.map((d) => d.field).sort()
    assert.deepEqual(fields, ['veltrix-alpha.docker_tag', 'veltrix-alpha.release_type'])
  } finally {
    restore()
  }
})

test('publisher-upgrade-profiles driftDetect: reports a profile disabled in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('upgrade_profiles', [
        { external_id: '4102', name: 'veltrix-alpha', docker_tag: '2.1.0', release_type: 'Latest', enabled: false },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})
