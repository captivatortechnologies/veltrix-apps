// driftDetect for zia-vpn-credentials.
//
// The shared contract covers the invariants: drift never writes, a deleted
// credential is critical drift, and a 500 is never reported as the credential
// being gone. What is specific here is small on purpose — `comments` is the only
// diffable field, because the type and identity are the reconciliation key and
// the pre-shared key is WRITE-ONLY: ZIA never returns it, so there is nothing to
// compare and every "diff" of it would be false. The deployed canvas still
// carries the key, so each result is checked for it.

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

const PSK = 'ipsec-psk-7f3a-MUST-NOT-LEAK'

const CREDENTIAL = item('Chicago tunnel', {
  type: 'UFQDN',
  fqdn: 'chicago@acme.com',
  comments: 'Chicago IPSec tunnel',
  pre_shared_key: PSK,
})

registerDriftContract({
  label: 'zia-vpn-credentials',
  handler: driftDetect,
  product: 'zia',
  items: [CREDENTIAL],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 3007,
  type: 'UFQDN',
  fqdn: 'chicago@acme.com',
  comments: 'Chicago IPSec tunnel',
  ...over,
})

test('zia-vpn-credentials driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([CREDENTIAL]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials driftDetect: reports changed comments without ever quoting the key', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ comments: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([CREDENTIAL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'chicago@acme.com.comments')
    assert.ok(diff, `expected a comments diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Chicago IPSec tunnel')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
    assert.equal(
      (JSON.stringify(result) ?? '').includes(PSK),
      false,
      'the deployed canvas carries the key — a diff must not',
    )
  } finally {
    restore()
  }
})

test('zia-vpn-credentials driftDetect: a credential deleted in the tenant is critical drift, by identity', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ id: 11, type: 'IP', fqdn: undefined, ipAddress: '198.51.100.7' })])])
  try {
    const result = await driftDetect(driftContext([CREDENTIAL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'chicago@acme.com')
    assert.ok(diff, `expected a missing diff keyed on the identity, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'missing')
    assert.equal(diff.severity, 'critical')
    assert.equal((JSON.stringify(result) ?? '').includes(PSK), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials driftDetect: an identity ZIA echoes back in another case is not drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ fqdn: 'Chicago@Acme.com' })])])
  try {
    const result = await driftDetect(driftContext([CREDENTIAL]))

    assert.equal(result.hasDrift, false, 'a tunnel identity is case-insensitive')
  } finally {
    restore()
  }
})

test('zia-vpn-credentials driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        comments: 'edited in the ZIA console',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([CREDENTIAL]))

    const diff = result.diffs.find((d) => d.field === 'chicago@acme.com.comments') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z', 'ZIA records epoch SECONDS')
  } finally {
    restore()
  }
})

test('zia-vpn-credentials driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        comments: 'set by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([CREDENTIAL]))

    const diff = result.diffs.find((d) => d.field === 'chicago@acme.com.comments') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
