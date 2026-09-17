// driftDetect for zia-admin-roles.
//
// The shared contract covers the invariants: drift never writes, a deleted role
// is critical drift, and a 500 is never reported as the role being gone. What is
// specific here is the comparison itself — `rank` is the ONLY managed field
// compared (the permissionsAccess maps behind role_json are deliberately not
// deep-diffed, because ZIA server-normalises them) — plus the attribution that
// rides on the live role's `lastModifiedBy`.
//
// NOT asserted, deliberately: a live role whose `rank` is absent or arrives as a
// string. The handler's `typeof found.rank === 'number'` guard skips the only
// comparison it makes and the role comes back in sync — see the report.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  recordFetch,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const ROLE = item('SOC Analyst', {
  name: 'SOC Analyst',
  rank: 3,
  role_json: '{"policyAccess":"READ_WRITE"}',
})

registerDriftContract({
  label: 'zia-admin-roles',
  handler: driftDetect,
  product: 'zia',
  items: [ROLE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 4102,
  name: 'SOC Analyst',
  rank: 3,
  isNameL10nTag: false,
  policyAccess: 'READ_WRITE',
  ...over,
})

test('zia-admin-roles driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([ROLE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-admin-roles driftDetect: reports a rank raised in the ZIA console', async () => {
  // Rank 1 is the most privileged — an admin role promoted by hand is exactly
  // the change this check exists to surface.
  const { restore } = recordFetch([TOKEN, ziaList([live({ rank: 1 })])])
  try {
    const result = await driftDetect(driftContext([ROLE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'SOC Analyst.rank')
    assert.ok(diff, `expected a rank diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '3')
    assert.equal(diff.actual, '1')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-admin-roles driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        rank: 1,
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([ROLE]))

    const diff = result.diffs.find((d) => d.field === 'SOC Analyst.rank') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-admin-roles driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        rank: 1,
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([ROLE]))

    const diff = result.diffs.find((d) => d.field === 'SOC Analyst.rank') as { actor?: unknown } | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
