// deploy for remote-networks.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the STAGED shape: every write only stages, and `POST /staged_config/
// deploy_status { type: 'INCREMENTAL' }` is what actually applies it. A deploy
// that staged changes and never issued that POST leaves the customer's console
// silently unchanged while the platform records a success.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  bodyOf,
  created,
  deployContext,
  deployInProgress,
  item,
  leaksToken,
  list,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  serverError,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const LIST_PATH = '/staged_config/remote_networks'
const DEPLOY_STATUS = '/staged_config/deploy_status'

const DMZ = item(
  'DMZ',
  {
    name: 'DMZ',
    description: 'Perimeter networks',
    group: 'Perimeter',
    cidrs: '10.0.0.0/8\n172.16.0.0/12',
  },
  'item-dmz',
)

/** The body every declared field of {@link DMZ} produces. */
const DMZ_BODY = {
  name: 'DMZ',
  description: 'Perimeter networks',
  group: 'Perimeter',
  cidrs: ['10.0.0.0/8', '172.16.0.0/12'],
}

function deployStatusCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((call) => call.url.endsWith(DEPLOY_STATUS))
}

registerDeployGuardContract({ label: 'remote-networks', handler: deploy, sampleItems: [DMZ] })

test('remote-networks deploy: creates a network that does not exist, then applies the staged change', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 77 }), ok({})])
  try {
    const result = await deploy(deployContext([DMZ]))

    assertQRadarHeaders(assert, calls)
    assert.equal(pathOf(calls[0]), LIST_PATH)
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), LIST_PATH, 'a create posts to the collection, not to an id')
    assert.deepEqual(bodyOf(calls[1]), DMZ_BODY)

    // Without this POST the write is staged and never applied.
    assert.equal(deployStatusCalls(calls).length, 1, 'the staged deploy is issued exactly once')
    assert.equal(calls.length, 3, 'the deploy_status POST comes after the resource writes')
    assert.equal(pathOf(calls[2]), DEPLOY_STATUS)
    assert.equal(calls[2].method, 'POST')
    assert.deepEqual(bodyOf(calls[2]), { type: 'INCREMENTAL' })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'DMZ')
    assert.equal(entries[0].existed, false, 'a network this deploy created must be marked not pre-existing')
    assert.equal(entries[0].id, 77, 'rollback can only delete what deploy wrote the id down for')
    assert.equal(entries[0].prior, undefined)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-networks deploy: updating an existing network records the LIVE prior state, not the desired one', async () => {
  // The live network differs from the canvas in BOTH directions: it carries a
  // CIDR the canvas does not declare and misses one it does. A handler that
  // recorded the canvas values as "prior" would look right on a no-op deploy
  // and overwrite the operator's ranges on rollback.
  const live = {
    id: 42,
    name: 'DMZ',
    description: 'edited in the console',
    group: 'Legacy',
    cidrs: ['10.0.0.0/8', '192.168.5.0/24'],
  }
  const { calls, restore } = recordFetch([list([live]), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), `${LIST_PATH}/42`, 'an update posts to the network id')
    assert.deepEqual(bodyOf(calls[1]), DMZ_BODY)
    assert.equal(deployStatusCalls(calls).length, 1)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 42)
    assert.deepEqual(entries[0].prior, {
      name: 'DMZ',
      description: 'edited in the console',
      group: 'Legacy',
      cidrs: ['10.0.0.0/8', '192.168.5.0/24'],
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('remote-networks deploy: a deploy that changed nothing does not issue a staged deploy', async () => {
  // POST /staged_config/deploy_status restarts services on the managed hosts.
  // Issuing it on every no-op redeploy would churn a production console.
  const live = { id: 42, name: 'DMZ', description: 'Perimeter networks', group: 'Perimeter', cidrs: ['172.16.0.0/12', '10.0.0.0/8'] }
  const { calls, restore } = recordFetch([list([live])])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(calls.length, 1, 'an in-sync network is read and left alone')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(deployStatusCalls(calls).length, 0, 'nothing was staged, so nothing needs applying')
    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true, 'a network left alone is still recorded for rollback')
  } finally {
    restore()
  }
})

test('remote-networks deploy: a deploy already in progress is success, not a failure', async () => {
  // QRadar's staged deploy is single-flight; a 409 / code 1002 means the
  // in-flight deploy will apply what we just staged. Failing here would mark a
  // perfectly good deploy failed and trigger a needless rollback.
  const { restore } = recordFetch([list([]), created({ id: 77 }), deployInProgress()])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Deployed 1 remote network/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-networks deploy: a rejected staged deploy fails but still returns what it staged', async () => {
  // The network now exists in QRadar's staged config. Dropping the rollbackData
  // here would leave it with nothing to undo.
  const { calls, restore } = recordFetch([list([]), created({ id: 77 }), serverError('Deploy could not be started')])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(deployStatusCalls(calls).length, 1)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Deploy could not be started/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the created network must still be recoverable')
    assert.equal(entries[0].id, 77)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-networks deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { calls, restore } = recordFetch([list([]), qradarError(422, 'CIDR 10.0.0.0/8 overlaps an existing remote network')])
  try {
    const result = await deploy(deployContext([DMZ]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /overlaps an existing remote network/)
    assert.equal(deployStatusCalls(calls).length, 0, 'nothing was staged, so no deploy is issued')
    const entries = (result.rollbackData as { entries: unknown[] }).entries
    assert.deepEqual(entries, [], 'a network that was never created records no rollback entry')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-networks deploy: a rejected update keeps the other networks and still applies them', async () => {
  const OTHER = item('Branch', { name: 'Branch', description: '', group: '', cidrs: '192.0.2.0/24' }, 'item-branch')
  const live = { id: 42, name: 'DMZ', description: 'stale', group: 'Perimeter', cidrs: [] }
  const { calls, restore } = recordFetch([
    list([live]),
    qradarError(403, 'You do not have the required capability for this endpoint'),
    created({ id: 88 }),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([DMZ, OTHER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.name), ['Branch'], 'the failed network records no entry, the created one does')
    assert.equal(deployStatusCalls(calls).length, 1, 'the network that WAS staged still gets applied')
  } finally {
    restore()
  }
})

test('remote-networks deploy: matches a renamed network by its recorded id rather than creating a duplicate', async () => {
  // Identity is the name, but a previous deploy wrote the QRadar id down. A
  // rename in the canvas must update that object, not leave the old one behind
  // and create a second overlapping remote network.
  const RENAMED = item('DMZ', { name: 'Perimeter DMZ', description: 'Perimeter networks', group: 'Perimeter', cidrs: '10.0.0.0/8' }, 'item-dmz')
  const live = { id: 42, name: 'DMZ', description: 'Perimeter networks', group: 'Perimeter', cidrs: ['10.0.0.0/8'] }
  const { calls, restore } = recordFetch([list([live]), ok({}), ok({})])
  try {
    const result = await deploy(
      deployContext([RENAMED], {
        priorRollbackData: { entries: [{ itemId: 'item-dmz', name: 'DMZ', existed: false, id: 42 }] },
      }),
    )

    assert.equal(pathOf(calls[1]), `${LIST_PATH}/42`, 'the recorded id wins over the changed name')
    assert.equal(bodyOf(calls[1])?.name, 'Perimeter DMZ')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'a rename must not produce a second network')
    assert.equal(entries[0].id, 42)
  } finally {
    restore()
  }
})

test('remote-networks deploy: reconcile-deletes only what this app created and no longer declares', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 77 }), ACCEPTED, ok({})])
  try {
    const result = await deploy(
      deployContext([DMZ], {
        priorRollbackData: {
          entries: [
            { itemId: 'item-retired', name: 'Retired Net', existed: false, id: 9 },
            { itemId: 'item-operator', name: 'Operator Owned', existed: true, id: 10 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${LIST_PATH}/9`])
    assert.equal(
      deletes.includes(`${LIST_PATH}/10`),
      false,
      'a network that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(deployStatusCalls(calls).length, 1)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('remote-networks deploy: a reconcile target already gone is not an error', async () => {
  // 404 is a known answer — the object we would delete is already absent, which
  // is the state the reconcile was trying to reach.
  const { restore } = recordFetch([list([]), notFound(), ok({})])
  try {
    const result = await deploy(
      deployContext([], { priorRollbackData: { entries: [{ name: 'Retired Net', existed: false, id: 9 }] } }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('remote-networks deploy: an empty canvas writes nothing and stages no deploy', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(deployStatusCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

// NOTE: `listRemoteNetworks` (deploy.ts:31) returns [] when the list read fails,
// so a 500 there sends every declared network down the CREATE branch. That path
// is deliberately unasserted — a test for it would document the bug as correct.
