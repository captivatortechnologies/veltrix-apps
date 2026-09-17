// deploy for network-hierarchy.
//
// This is the only WHOLE-LIST type in the app: QRadar exposes the hierarchy as
// one staged collection replaced by a single PUT, so every deploy rewrites
// objects the app does not own. That makes two things load-bearing and nothing
// else comes close:
//
//   * the PUT must carry the operator's existing objects alongside the declared
//     ones, or deploying one subnet deletes the customer's whole hierarchy;
//   * the rollback snapshot must be the list as it was read BEFORE the write.
//
// The writes only stage; `POST /staged_config/deploy_status` applies them.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  arrayBodyOf,
  bodyOf,
  deployContext,
  deployInProgress,
  item,
  leaksToken,
  list,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  serverError,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { networkKey } from '../validate'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const DMZ = item('DMZ', {
  group: 'Perimeter',
  name: 'DMZ',
  cidr: '10.20.0.0/16',
  description: 'Perimeter DMZ range',
  countryCode: 'GB',
})

registerDeployGuardContract({ label: 'network-hierarchy', handler: deploy, sampleItems: [DMZ] })

/** One object as `GET /config/network_hierarchy/staged_networks` returns it. */
function liveNetwork(over: Record<string, unknown>) {
  return { id: 900, network_id: 900, group: 'Corp', name: 'Office', cidr: '192.168.0.0/16', description: '', ...over }
}

test('network-hierarchy deploy: the replacement list keeps the operator objects it does not own', async () => {
  // The single most expensive failure this type can have: a PUT that carried
  // only the declared objects would delete every network the operator maintains
  // by hand, and QRadar's event/flow routing depends on them.
  const operatorOwned = liveNetwork({ id: 901, group: 'Corp', name: 'Office', cidr: '192.168.0.0/16' })
  const { calls, restore } = recordFetch([list([operatorOwned]), ok({}), ACCEPTED])
  try {
    const result = await deploy(deployContext([DMZ]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), '/config/network_hierarchy/staged_networks')
    assert.equal(calls[0].range, 'items=0-9999')

    assert.equal(calls[1].method, 'PUT')
    assert.equal(pathOf(calls[1]), '/config/network_hierarchy/staged_networks')
    const put = arrayBodyOf(calls[1])
    assert.ok(put)
    assert.equal(put.length, 2, 'the replacement list is preserved objects plus declared objects')
    assert.deepEqual(put[0], operatorOwned, 'an unowned object is written back exactly as it was read')
    assert.deepEqual(put[1], {
      group: 'Perimeter',
      name: 'DMZ',
      cidr: '10.20.0.0/16',
      description: 'Perimeter DMZ range',
      country_code: 'GB',
    })

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 preserved/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: records the list as it was BEFORE the write', async () => {
  // Rollback for this type is "PUT the snapshot back". A snapshot taken after
  // the write, or built from the canvas, restores the change rather than undoing
  // it — so the live fixture is deliberately nothing like the canvas.
  const before = [
    liveNetwork({ id: 901, group: 'Corp', name: 'Office', cidr: '192.168.0.0/16', description: 'set by hand' }),
    liveNetwork({ id: 902, group: 'Perimeter', name: 'DMZ', cidr: '10.99.0.0/16', description: 'edited in console' }),
  ]
  const { restore } = recordFetch([list(before), ok({}), ACCEPTED])
  try {
    const result = await deploy(deployContext([DMZ]))

    const data = result.rollbackData as { priorList: unknown[]; entries: Array<Record<string, unknown>> }
    assert.deepEqual(data.priorList, before, 'the snapshot is the live list, not the list that was written')
    assert.equal(
      (data.priorList[1] as Record<string, unknown>).cidr,
      '10.99.0.0/16',
      'the snapshot holds the console CIDR, not the canvas one',
    )
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: an object that pre-existed this app is recorded as pre-existing', async () => {
  // `existed` decides whether a later deploy may drop the object from the
  // replacement list. Getting it wrong in this direction deletes an operator's
  // network; in the other, the app's own object is never cleaned up.
  const { restore } = recordFetch([
    list([liveNetwork({ group: 'Perimeter', name: 'DMZ', cidr: '10.99.0.0/16' })]),
    ok({}),
    ACCEPTED,
  ])
  try {
    const result = await deploy(deployContext([DMZ]))

    const data = result.rollbackData as { entries: Array<Record<string, unknown>> }
    assert.deepEqual(data.entries, [{ key: networkKey('Perimeter', 'DMZ'), existed: true }])
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: an object this app created before stays app-owned', async () => {
  // It is live now only because a previous deploy put it there, so redeclaring
  // it must not promote it to operator-owned.
  const { restore } = recordFetch([
    list([liveNetwork({ group: 'Perimeter', name: 'DMZ', cidr: '10.20.0.0/16' })]),
    ok({}),
    ACCEPTED,
  ])
  try {
    const result = await deploy(
      deployContext([DMZ], {
        priorRollbackData: { entries: [{ key: networkKey('Perimeter', 'DMZ'), existed: false }], priorList: [] },
      }),
    )

    const data = result.rollbackData as { entries: Array<Record<string, unknown>> }
    assert.deepEqual(data.entries, [{ key: networkKey('Perimeter', 'DMZ'), existed: false }])
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: drops an object it created before and no longer declares', async () => {
  const retired = liveNetwork({ id: 903, group: 'Lab', name: 'Retired', cidr: '172.31.0.0/16' })
  const operatorOwned = liveNetwork({ id: 901, group: 'Corp', name: 'Office' })
  const { calls, restore } = recordFetch([list([operatorOwned, retired]), ok({}), ACCEPTED])
  try {
    await deploy(
      deployContext([DMZ], {
        priorRollbackData: { entries: [{ key: networkKey('Lab', 'Retired'), existed: false }], priorList: [] },
      }),
    )

    const put = arrayBodyOf(calls[1])
    assert.ok(put)
    assert.deepEqual(
      put.map((n) => (n as Record<string, unknown>).name),
      ['Office', 'DMZ'],
      'the app-created object is dropped; the operator-owned one survives',
    )
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: refuses to replace a hierarchy it could not read', async () => {
  // This deploy sends a whole-list REPLACE, and the list it sends is built from
  // the read. A failed read used to become `[]`, so one 500 on this GET deleted
  // every network the operator maintains by hand — and the same run recorded
  // that empty list as the rollback snapshot, destroying the way back. QRadar
  // routes events by this hierarchy.
  const { calls, restore } = recordFetch([serverError('Staged config is locked')])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Could not read the staged network hierarchy/)
    assert.equal(writeCalls(calls).length, 0, 'not writing is the only safe answer to an unreadable list')
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: applies the staged list with an INCREMENTAL deploy', async () => {
  const { calls, restore } = recordFetch([list([]), ok({}), ACCEPTED])
  try {
    await deploy(deployContext([DMZ]))

    assert.equal(calls.length, 3)
    assert.equal(calls[2].method, 'POST')
    assert.equal(pathOf(calls[2]), '/staged_config/deploy_status')
    assert.deepEqual(bodyOf(calls[2]), { type: 'INCREMENTAL' })
    assert.equal(calls[2].contentType, 'application/json')
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: a rejected replace fails without applying anything', async () => {
  // Applying after a failed stage would push whatever was already staged by
  // someone else — the deploy must stop at the PUT.
  const { calls, restore } = recordFetch([list([]), qradarError(422, 'Overlapping CIDR range in the hierarchy')])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(calls.length, 2, 'no deploy_status call after a failed stage')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Overlapping CIDR range/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: a failed replace hands back the PREVIOUS snapshot, not an empty one', async () => {
  // Nothing was written, so the older snapshot is still the correct thing to
  // restore. Returning this run's (unused) state would strand the operator.
  const previous = { entries: [{ key: 'lab old', existed: false }], priorList: [liveNetwork({ id: 800, name: 'Old' })] }
  const { restore } = recordFetch([list([liveNetwork({ id: 901 })]), serverError('Staged config is locked')])
  try {
    const result = await deploy(deployContext([DMZ], { priorRollbackData: previous }))

    assert.equal(result.success, false)
    assert.deepEqual(result.rollbackData, previous)
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: a concurrent QRadar deploy counts as applied', async () => {
  // QRadar's deploy is single-flight and rejects a second one with 409/1002.
  // The in-flight deploy applies everything currently staged, including ours.
  const { restore } = recordFetch([list([]), ok({}), deployInProgress()])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: a failed apply is reported as staged-but-not-live', async () => {
  const { restore } = recordFetch([list([]), ok({}), serverError('Deploy service unavailable')])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /staged but deploy failed/)
    assert.match(String(result.message), /Deploy service unavailable/)
    const data = result.rollbackData as { priorList: unknown[] }
    assert.ok(Array.isArray(data.priorList), 'the snapshot survives a failed apply')
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: an object missing a group, a name or a CIDR is not written', async () => {
  // A half-filled canvas row would otherwise be PUT as an object with blank
  // identity, which QRadar accepts and an operator cannot find again.
  const { calls, restore } = recordFetch([list([]), ok({}), ACCEPTED])
  try {
    await deploy(
      deployContext([
        DMZ,
        item('No group', { name: 'No group', cidr: '10.1.0.0/16' }),
        item('No cidr', { group: 'Perimeter', name: 'No cidr' }),
      ]),
    )

    const put = arrayBodyOf(calls[1])
    assert.ok(put)
    assert.deepEqual(put.map((n) => (n as Record<string, unknown>).name), ['DMZ'])
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: sends the domain id only when the canvas declares one', async () => {
  const { calls, restore } = recordFetch([list([]), ok({}), ACCEPTED])
  try {
    await deploy(
      deployContext([
        item('Tenant A', { group: 'Tenants', name: 'Tenant A', cidr: '10.30.0.0/16', domainId: '7' }),
        item('Shared', { group: 'Tenants', name: 'Shared', cidr: '10.31.0.0/16' }),
      ]),
    )

    const put = arrayBodyOf(calls[1]) as Array<Record<string, unknown>>
    assert.equal(put[0].domain_id, 7, 'a numeric string domain id is sent as a number')
    assert.equal('domain_id' in put[1], false, 'an undeclared domain id is omitted, not sent as null')
  } finally {
    restore()
  }
})

test('network-hierarchy deploy: an empty canvas still writes, and only the preserved objects survive', async () => {
  // Withdrawing every declared object is a legitimate intent; what it must not
  // do is take the operator's objects with it.
  const operatorOwned = liveNetwork({ id: 901, group: 'Corp', name: 'Office' })
  const { calls, restore } = recordFetch([list([operatorOwned]), ok({}), ACCEPTED])
  try {
    const result = await deploy(deployContext([]))

    assert.deepEqual(arrayBodyOf(calls[1]), [operatorOwned])
    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 2, 'one PUT and one deploy POST')
  } finally {
    restore()
  }
})
