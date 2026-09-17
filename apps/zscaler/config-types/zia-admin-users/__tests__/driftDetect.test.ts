// driftDetect for zia-admin-users.
//
// The shared contract covers the invariants: drift never writes, a deleted
// account is critical drift, and a 500 is never reported as the account being
// gone. What is specific here is the comparison itself — `email` and `disabled`
// are the managed fields compared, the write-only password is never diffed, and
// attribution rides on the live account's `lastModifiedBy`.
//
// NOT asserted, deliberately: the account's ROLE. deploy writes it, but drift
// never compares it, so an admin promoted in the ZIA console comes back in sync —
// see the report.

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

const PASSWORD = 'zia-admin-password-MUST-NOT-LEAK'

const USER = item('SOC Analyst account', {
  login_name: 'soc.analyst@acme.com',
  user_name: 'SOC Analyst',
  email: 'soc.analyst@acme.com',
  role_name: 'SOC Analyst',
  disabled: false,
  password: PASSWORD,
})

registerDriftContract({
  label: 'zia-admin-users',
  handler: driftDetect,
  product: 'zia',
  items: [USER],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 5501,
  loginName: 'soc.analyst@acme.com',
  userName: 'SOC Analyst',
  email: 'soc.analyst@acme.com',
  role: { id: 7, name: 'SOC Analyst' },
  disabled: false,
  ...over,
})

test('zia-admin-users driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-admin-users driftDetect: reports an email redirected in the ZIA console', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ email: 'attacker@evil.example' })])])
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'soc.analyst@acme.com.email')
    assert.ok(diff, `expected an email diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'soc.analyst@acme.com')
    assert.equal(diff.actual, 'attacker@evil.example')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-admin-users driftDetect: reports an account disabled out from under the canvas', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ disabled: true })])])
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'soc.analyst@acme.com.disabled')
    assert.ok(diff)
    assert.equal(diff.expected, 'false')
    assert.equal(diff.actual, 'true')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-admin-users driftDetect: never puts the write-only password in a diff', async () => {
  // ZIA never returns a password, so there is nothing to compare — and the one
  // the canvas carries must not travel into a drift record either.
  const { restore } = recordFetch([TOKEN, ziaList([live({ email: 'changed@acme.com', disabled: true })])])
  try {
    const result = await driftDetect(driftContext([USER]))

    assert.equal(result.hasDrift, true)
    assert.equal(JSON.stringify(result).includes(PASSWORD), false)
    assert.equal(
      result.diffs.some((d) => String(d.field).endsWith('.password')),
      false,
    )
  } finally {
    restore()
  }
})

test('zia-admin-users driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        disabled: true,
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([USER]))

    const diff = result.diffs.find((d) => d.field === 'soc.analyst@acme.com.disabled') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-admin-users driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        disabled: true,
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([USER]))

    const diff = result.diffs.find((d) => d.field === 'soc.analyst@acme.com.disabled') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
