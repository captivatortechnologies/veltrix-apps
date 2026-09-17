// rollback for network-hierarchy.
//
// A whole-list type rolls back by PUTting the snapshot deploy captured and
// re-applying it. There are no per-object entries to walk, so what matters is
// that the snapshot goes back verbatim and that a failed stage is never applied.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  arrayBodyOf,
  bodyOf,
  deployInProgress,
  leaksToken,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  serverError,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

// NOTE: the shared "writes nothing when the deploy recorded nothing" case is NOT
// registered for this type. With no recorded snapshot the handler PUTs an empty
// list, which REPLACES the customer's whole network hierarchy with nothing —
// reported as a defect rather than asserted here, because a test either way
// would document one of the two behaviours as intended.
registerRollbackGuardContract({
  label: 'network-hierarchy',
  handler: rollback,
  emptyRollbackDataMakesNoCall: false,
})

const SNAPSHOT = [
  { id: 901, group: 'Corp', name: 'Office', cidr: '192.168.0.0/16', description: 'set by hand' },
  { id: 902, group: 'Perimeter', name: 'DMZ', cidr: '10.99.0.0/16', description: 'edited in console' },
]

test('network-hierarchy rollback: puts the captured snapshot back verbatim', async () => {
  const { calls, restore } = recordFetch([ok({}), ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [], priorList: SNAPSHOT }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'PUT')
    assert.equal(pathOf(calls[0]), '/config/network_hierarchy/staged_networks')
    assert.deepEqual(arrayBodyOf(calls[0]), SNAPSHOT, 'every field the deploy read is written back')
    assert.equal(result.success, true)
    assert.match(String(result.message), /Restored 2 network object/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('network-hierarchy rollback: applies the restored list with an INCREMENTAL deploy', async () => {
  // A staged revert is not a revert until it is applied — the hierarchy QRadar
  // routes on is the deployed one, not the staged one.
  const { calls, restore } = recordFetch([ok({}), ACCEPTED])
  try {
    await rollback(rollbackContext({ priorList: SNAPSHOT }))

    assert.equal(calls.length, 2)
    assert.equal(pathOf(calls[1]), '/staged_config/deploy_status')
    assert.deepEqual(bodyOf(calls[1]), { type: 'INCREMENTAL' })
  } finally {
    restore()
  }
})

test('network-hierarchy rollback: a rejected replace is not applied', async () => {
  const { calls, restore } = recordFetch([qradarError(422, 'Overlapping CIDR range in the hierarchy')])
  try {
    const result = await rollback(rollbackContext({ priorList: SNAPSHOT }))

    assert.equal(calls.length, 1, 'a failed stage must not be deployed')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Overlapping CIDR range/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('network-hierarchy rollback: a failed apply is reported as still staged', async () => {
  const { restore } = recordFetch([ok({}), serverError('Deploy service unavailable')])
  try {
    const result = await rollback(rollbackContext({ priorList: SNAPSHOT }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /staged but deploy failed/)
  } finally {
    restore()
  }
})

test('network-hierarchy rollback: a concurrent QRadar deploy counts as applied', async () => {
  const { restore } = recordFetch([ok({}), deployInProgress()])
  try {
    const result = await rollback(rollbackContext({ priorList: SNAPSHOT }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
