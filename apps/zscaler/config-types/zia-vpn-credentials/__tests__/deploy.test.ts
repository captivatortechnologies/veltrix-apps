// deploy for zia-vpn-credentials.
//
// This is the config type that handles a SECRET: the IPSec pre-shared key. ZIA
// never returns it on GET, so the canvas is the only source of truth and deploy
// re-asserts it on every create and update. Everything here is therefore two
// assertions at once — the PSK must reach the vendor in the write body, and it
// must appear in NOTHING the platform persists or shows: the result message, the
// artifacts and, above all, `rollbackData`.
//
// Also specific to this type: identity is CONDITIONAL — the fqdn for a UFQDN
// credential, the ip_address for an IP one — and it is what the rollback entry
// is keyed on (`identity`), never the secret.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

/** The IPSec pre-shared key. Distinctive so it can be searched for anywhere. */
const PSK = 'ipsec-psk-7f3a-MUST-NOT-LEAK'

/** True when the PSK appears anywhere in the serialised value. */
function mentionsPsk(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(PSK)
}

const CREDENTIAL = item('Chicago tunnel', {
  type: 'UFQDN',
  fqdn: 'chicago@acme.com',
  comments: 'Chicago IPSec tunnel',
  pre_shared_key: PSK,
})

/**
 * The live credential, deliberately UNLIKE the canvas: a different comment set
 * by hand. A rollback entry that mirrors the canvas rather than this has
 * recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 3007,
  type: 'UFQDN',
  fqdn: 'chicago@acme.com',
  comments: 'legacy comment set by hand',
}

registerDeployGuardContract({
  label: 'zia-vpn-credentials',
  handler: deploy,
  product: 'zia',
  items: [CREDENTIAL],
})

test('zia-vpn-credentials deploy: creates a UFQDN credential, sending the PSK to the vendor only', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 11, type: 'IP', ipAddress: '198.51.100.7' }]),
    created({ id: 3007, type: 'UFQDN', fqdn: 'chicago@acme.com' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([CREDENTIAL]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/vpnCredentials\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/vpnCredentials$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.type, 'UFQDN')
    assert.equal(body?.fqdn, 'chicago@acme.com')
    assert.equal(body?.comments, 'Chicago IPSec tunnel')
    assert.equal(body?.preSharedKey, PSK, 'the tunnel cannot come up without the key on the wire')
    assert.equal('ipAddress' in (body ?? {}), false, 'a UFQDN credential carries no ip_address')

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    // The secret reaches the vendor and stops there.
    assert.equal(mentionsPsk(result.message), false, 'the message must not echo the pre-shared key')
    assert.equal(mentionsPsk(result.artifacts), false, 'artifacts must not carry the pre-shared key')
    assert.equal(mentionsPsk(result.rollbackData), false, 'rollbackData is persisted — it must not carry the key')
    assert.equal(mentionsPsk(result), false)
    assert.equal(leaksSecret(result), false)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [
      { identity: 'chicago@acme.com', existed: false, id: 3007 },
    ])
    assert.deepEqual(rollback.createdIds, [3007])
  } finally {
    restore()
  }
})

test('zia-vpn-credentials deploy: an IP credential is keyed on its ip_address, not an fqdn', async () => {
  const ipCredential = item('Branch tunnel', {
    type: 'IP',
    ip_address: '203.0.113.10',
    comments: 'Branch IPSec tunnel',
    pre_shared_key: PSK,
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 3101 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([ipCredential]))

    const body = bodyOf(calls.filter((c) => c.method === 'POST' && c.url.includes('/vpnCredentials'))[0])
    assert.equal(body?.type, 'IP')
    assert.equal(body?.ipAddress, '203.0.113.10')
    assert.equal('fqdn' in (body ?? {}), false)
    assert.equal(body?.preSharedKey, PSK)

    assert.equal(result.success, true)
    const rollback = result.rollbackData as { previousState: Array<{ identity: string }> }
    assert.equal(rollback.previousState[0].identity, '203.0.113.10')
    assert.equal(mentionsPsk(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials deploy: updates an existing credential and records its LIVE prior body, without the key', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 3007 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([CREDENTIAL]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a credential that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/vpnCredentials\/3007$/)
    assert.equal(bodyOf(tenant[1])?.preSharedKey, PSK, 'the key is re-asserted on update too')
    assert.equal(bodyOf(tenant[1])?.comments, 'Chicago IPSec tunnel')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ identity: string; existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.identity, 'chicago@acme.com', 'the entry is keyed on the identity, never the secret')
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 3007)
    assert.equal(entry.prior.comments, 'legacy comment set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.type, 'UFQDN')
    assert.equal(entry.prior.fqdn, 'chicago@acme.com')
    assert.equal('preSharedKey' in entry.prior, false, 'the write-only key is never captured')
    assert.equal(mentionsPsk(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials deploy: a rejected write fails the deploy rather than throwing, and keeps the key out of the failure', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Pre-shared key does not meet the complexity requirements'),
  ])
  try {
    const result = await deploy(deployContext([CREDENTIAL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /does not meet the complexity requirements/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live credential, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { comments?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.comments, 'legacy comment set by hand')
    assert.equal(mentionsPsk(result), false, 'a vendor error about the key must not quote the key')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/vpnCredentials/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([CREDENTIAL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list VPN credentials/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
    assert.equal(mentionsPsk(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 3007 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([CREDENTIAL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [3007], 'the staged credential still exists and must be revertible')
    assert.equal(mentionsPsk(result), false)
  } finally {
    restore()
  }
})

test('zia-vpn-credentials deploy: a create whose response carries no id fails rather than throwing', async () => {
  // NOTE: what rollbackData holds here is deliberately NOT asserted. The POST
  // succeeded, so a credential carrying this PSK now exists in the tenant, but
  // deploy throws on the missing id BEFORE pushing a rollback entry — see the
  // report accompanying these tests. Asserting the empty previousState would
  // bless that.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ fqdn: 'chicago@acme.com' })])
  try {
    const result = await deploy(deployContext([CREDENTIAL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
    assert.equal(mentionsPsk(result), false)
  } finally {
    restore()
  }
})
