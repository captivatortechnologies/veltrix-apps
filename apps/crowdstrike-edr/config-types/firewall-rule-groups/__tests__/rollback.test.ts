// rollback for firewall-rule-groups.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that an UPDATED group is converged back through the SAME
// JSON-patch mechanism deploy uses — so the restore has to re-read the group for
// its current tracking token, and the rule set it writes back has to be the one
// deploy recorded from the live tenant, not anything derived from the canvas.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  entityPage,
  forbidden,
  leaksSecret,
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  serverError,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/fwmgr\/entities\/rule-groups\/v1/

/** The prior rule set deploy captured, in its canonical (rollback) shape. */
const PRIOR_RULE = {
  name: 'Allow lab RDP',
  description: '',
  enabled: true,
  monitor: false,
  action: 'ALLOW',
  direction: 'OUT',
  protocolWire: '6',
  addressFamily: 'IP4',
  localPorts: [],
  remotePorts: [{ start: 3389, end: 0 }],
  localAddresses: [],
  remoteAddresses: [],
  icmpType: '',
  icmpCode: '',
  networkLocation: 'ANY',
}

const CREATED_ENTRY = {
  name: 'veltrix-fw-windows',
  platform: 'windows',
  existed: false,
  id: 'frg-new-1',
}

const UPDATED_ENTRY = {
  name: 'veltrix-fw-windows',
  platform: 'windows',
  existed: true,
  id: 'frg-live-1',
  prior: {
    name: 'veltrix-fw-windows',
    description: 'legacy description nobody updated',
    enabled: false,
    rules: [PRIOR_RULE],
  },
}

/** The group as rollback finds it now — deploy's changes still applied. */
const CURRENT_GROUP = {
  id: 'frg-live-1',
  name: 'veltrix-fw-windows',
  platform: 'windows',
  description: 'No SMB egress',
  enabled: true,
  tracking: 'tracking-token-xyz',
  rules: [
    {
      id: 'fr-smb',
      name: 'Block outbound SMB',
      description: 'No SMB egress',
      enabled: true,
      action: 'DENY',
      direction: 'OUT',
      protocol: '6',
      address_family: 'IP4',
      local_port: [],
      remote_port: [{ start: 445, end: 0 }],
      local_address: [],
      remote_address: [],
      fields: [{ name: 'network_location', type: 'set', values: ['ANY'] }],
    },
  ],
}

registerRollbackGuardContract({
  label: 'firewall-rule-groups',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('firewall-rule-groups rollback: deletes a group this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=frg-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created group is deleted, not patched')
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: treats a 404 on the delete as already gone', async () => {
  // "Gone" is a known answer, unlike a 5xx — a concurrent delete must be a no-op.
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'veltrix-fw-windows', platform: 'windows', existed: false }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: converges an updated group back to its recorded prior rules', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([CURRENT_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a group that existed before the deploy must never be deleted',
    )

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.id, 'frg-live-1')
    assert.equal(
      body?.tracking,
      'tracking-token-xyz',
      'the restore must re-read the group for its CURRENT tracking token',
    )

    const ops = body?.diff_operations as Array<Record<string, unknown>>
    assert.ok(
      ops.some((op) => op.op === 'replace' && op.path === '/enabled' && op.value === false),
      `expected the group put back to disabled, got ${JSON.stringify(ops)}`,
    )
    assert.ok(
      ops.some(
        (op) =>
          op.op === 'replace' &&
          op.path === '/description' &&
          op.value === 'legacy description nobody updated',
      ),
      'the description must go back to the LIVE prior text',
    )
    const added = ops.filter((op) => op.op === 'add')
    assert.equal(added.length, 1, 'the prior rule is put back')
    assert.equal((added[0].value as Record<string, unknown>).name, 'Allow lab RDP')
    assert.equal((added[0].value as Record<string, unknown>).action, 'ALLOW')
    assert.ok(
      ops.some((op) => op.op === 'remove' && op.path === '/rules/0'),
      'the rule the deploy added is taken back out',
    )
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: writes nothing when the group it would restore no longer exists', async () => {
  // A group deleted out of band has nothing to converge, and writing a diff
  // against a group that is gone would either fail or recreate something.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'GET', respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: a failed re-read stops the restore rather than writing a stale diff', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: serverError() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      `rollback wrote after a failed read: ${describeCalls(writeCalls(calls))}`,
    )
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy converged a live group but recorded no prior body. Restoring an
  // invented default here would leave the group with no rules at all.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'veltrix-fw-windows', platform: 'windows', existed: true, id: 'frg-live-1' },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'veltrix-fw-windows',
            platform: 'windows',
            existed: true,
            prior: { enabled: false, rules: [PRIOR_RULE] },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'GET', respond: entityPage([CURRENT_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('rule group tracking token is out of date') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored group')
    assert.match(String(result.message), /out of date/)
  } finally {
    restore()
  }
})

test('firewall-rule-groups rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...CREATED_ENTRY, name: 'veltrix-fw-mac', platform: 'mac', id: 'frg-new-2' }
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
