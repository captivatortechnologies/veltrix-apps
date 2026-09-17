// deploy for flow-vlans.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the identity rule: a flow VLAN has no name, so the (enterprise_vlan_id,
// customer_vlan_id) PAIR is the identity — not the canvas item id and not the
// label. A handler that matched on either would see an edited VLAN id as an
// update it cannot perform, and leave the console holding the old pair.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  notFound,
  pathOf,
  qradarError,
  recordFetch,
  serverError,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/ariel/flow_vlans'

const GUEST = item('Guest WiFi', { label: 'Guest WiFi', enterpriseVlanId: 10, customerVlanId: 200 }, 'item-guest')

registerDeployGuardContract({ label: 'flow-vlans', handler: deploy, sampleItems: [GUEST] })

test('flow-vlans deploy: creates a pair that does not exist and records it as created', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 5, enterprise_vlan_id: 10, customer_vlan_id: 200 })])
  try {
    const result = await deploy(deployContext([GUEST]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    assert.equal(calls.length, 2)
    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), PATH)
    assert.deepEqual(bodyOf(calls[1]), { enterprise_vlan_id: 10, customer_vlan_id: 200 })
    assert.equal(
      String(calls[1].body).includes('Guest WiFi'),
      false,
      'the label is a canvas-only display name and is never sent to QRadar',
    )

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'item-guest', label: 'Guest WiFi', pairKey: '10:200', existed: false, id: 5 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: a live pair is recorded as existing with NO write, whatever the label says', async () => {
  // Matching is on the pair alone. Re-posting an existing pair would either be
  // rejected or duplicate it, and there is no update endpoint to reconcile with.
  const RELABELLED = item('Renamed in the canvas', { label: 'Renamed in the canvas', enterpriseVlanId: 10, customerVlanId: 200 }, 'item-other')
  const { calls, restore } = recordFetch([list([{ id: 12, enterprise_vlan_id: 10, customer_vlan_id: 200 }])])
  try {
    const result = await deploy(deployContext([RELABELLED]))

    assert.equal(calls.length, 1, 'an existing pair is read and left alone')
    assert.equal(writeCalls(calls).length, 0)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [
      { itemId: 'item-other', label: 'Renamed in the canvas', pairKey: '10:200', existed: true, id: 12 },
    ])
    assert.equal(result.success, true)
    assert.match(String(result.message), /\(0 created\)/)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: a live row with no enterprise VLAN matches a spec declaring 0', async () => {
  // 0 means "no enterprise VLAN field for this pair" and QRadar omits it from
  // the response. Reading the absent field as anything else would create a
  // duplicate pair on every single deploy.
  const NO_ENTERPRISE = item('Flat VLAN', { label: 'Flat VLAN', customerVlanId: 300 }, 'item-flat')
  const { calls, restore } = recordFetch([list([{ id: 3, customer_vlan_id: 300 }])])
  try {
    const result = await deploy(deployContext([NO_ENTERPRISE]))

    assert.equal(writeCalls(calls).length, 0)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].pairKey, '0:300')
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: changing a VLAN id creates the new pair and reconcile-deletes the old one', async () => {
  // Same canvas item, same label, edited customer VLAN. Because identity is the
  // pair, this is a create plus a delete of what the previous deploy recorded —
  // not an update. A handler keyed on the item id would leave VLAN 200 behind,
  // still classifying flows against a network the canvas no longer declares.
  const MOVED = item('Guest WiFi', { label: 'Guest WiFi', enterpriseVlanId: 10, customerVlanId: 201 }, 'item-guest')
  const { calls, restore } = recordFetch([
    list([{ id: 12, enterprise_vlan_id: 10, customer_vlan_id: 200 }]),
    created({ id: 13, enterprise_vlan_id: 10, customer_vlan_id: 201 }),
    ACCEPTED,
  ])
  try {
    const result = await deploy(
      deployContext([MOVED], {
        priorRollbackData: {
          entries: [{ itemId: 'item-guest', label: 'Guest WiFi', pairKey: '10:200', existed: false, id: 12 }],
        },
      }),
    )

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [`POST ${PATH}`, `DELETE ${PATH}/12`],
      'the new pair is created before the old one is removed',
    )
    assert.deepEqual(bodyOf(calls[1]), { enterprise_vlan_id: 10, customer_vlan_id: 201 })
    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'item-guest', label: 'Guest WiFi', pairKey: '10:201', existed: false, id: 13 }])
  } finally {
    restore()
  }
})

test('flow-vlans deploy: never reconcile-deletes a pair that pre-existed this app', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 5 }), ACCEPTED])
  try {
    const result = await deploy(
      deployContext([GUEST], {
        priorRollbackData: {
          entries: [
            { label: 'Retired', pairKey: '20:400', existed: false, id: 8 },
            { label: 'Operator Owned', pairKey: '30:500', existed: true, id: 9 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${PATH}/8`])
    assert.equal(deletes.includes(`${PATH}/9`), false, 'a pair this app did not create must never be deleted')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: a reconcile target already gone is not an error', async () => {
  // 404 is a known answer — the pair we would delete is already absent, which is
  // the state the reconcile was trying to reach.
  const { restore } = recordFetch([list([]), notFound()])
  try {
    const result = await deploy(
      deployContext([], { priorRollbackData: { entries: [{ label: 'Retired', pairKey: '20:400', existed: false, id: 8 }] } }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: a rejected reconcile-delete fails the deploy but keeps the created entries', async () => {
  const { restore } = recordFetch([list([]), created({ id: 5 }), serverError('Flow VLAN is referenced by a domain')])
  try {
    const result = await deploy(
      deployContext([GUEST], {
        priorRollbackData: { entries: [{ label: 'Retired', pairKey: '20:400', existed: false, id: 8 }] },
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /delete Retired: Flow VLAN is referenced by a domain/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the pair this run created must still be recoverable')
    assert.equal(entries[0].id, 5)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: a rejected create is a failed result that keeps what succeeded', async () => {
  const OTHER = item('Lab', { label: 'Lab', enterpriseVlanId: 0, customerVlanId: 999 }, 'item-lab')
  const { restore } = recordFetch([
    list([{ id: 12, enterprise_vlan_id: 10, customer_vlan_id: 200 }]),
    qradarError(422, 'A flow VLAN with that combination already exists'),
  ])
  try {
    const result = await deploy(deployContext([GUEST, OTHER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Lab: A flow VLAN with that combination already exists/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.label), ['Guest WiFi'], 'the pair already present stays recorded')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('flow-vlans deploy: an empty canvas with nothing recorded before writes nothing', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

// NOTE: `listFlowVlans` (deploy.ts:25) returns [] when the list read fails, so a
// 500 there sends every declared pair down the CREATE branch. That path is
// deliberately unasserted — a test for it would document the bug as correct.
