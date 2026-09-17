// deploy for remote-services.
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

const LIST_PATH = '/staged_config/remote_services'
const DEPLOY_STATUS = '/staged_config/deploy_status'

const CLOUD_BACKUP = item(
  'Cloud Backup',
  {
    name: 'Cloud Backup',
    description: 'Offsite backup targets',
    group: 'Sanctioned SaaS',
    cidrs: '198.51.100.0/24\n203.0.113.0/24',
  },
  'item-backup',
)

/** The body every declared field of {@link CLOUD_BACKUP} produces. */
const CLOUD_BACKUP_BODY = {
  name: 'Cloud Backup',
  description: 'Offsite backup targets',
  group: 'Sanctioned SaaS',
  cidrs: ['198.51.100.0/24', '203.0.113.0/24'],
}

function deployStatusCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((call) => call.url.endsWith(DEPLOY_STATUS))
}

registerDeployGuardContract({ label: 'remote-services', handler: deploy, sampleItems: [CLOUD_BACKUP] })

test('remote-services deploy: creates a service that does not exist, then applies the staged change', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 55 }), ok({})])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP]))

    assertQRadarHeaders(assert, calls)
    assert.equal(pathOf(calls[0]), LIST_PATH)
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), LIST_PATH, 'a create posts to the collection, not to an id')
    assert.deepEqual(bodyOf(calls[1]), CLOUD_BACKUP_BODY)

    // Without this POST the write is staged and never applied.
    assert.equal(deployStatusCalls(calls).length, 1, 'the staged deploy is issued exactly once')
    assert.equal(calls.length, 3, 'the deploy_status POST comes after the resource writes')
    assert.equal(pathOf(calls[2]), DEPLOY_STATUS)
    assert.equal(calls[2].method, 'POST')
    assert.deepEqual(bodyOf(calls[2]), { type: 'INCREMENTAL' })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Cloud Backup')
    assert.equal(entries[0].existed, false, 'a service this deploy created must be marked not pre-existing')
    assert.equal(entries[0].id, 55, 'rollback can only delete what deploy wrote the id down for')
    assert.equal(entries[0].prior, undefined)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-services deploy: updating an existing service records the LIVE prior state, not the desired one', async () => {
  // The live service differs from the canvas in BOTH directions: it carries a
  // CIDR the canvas does not declare and misses one it does. A handler that
  // recorded the canvas values as "prior" would look right on a no-op deploy
  // and overwrite the operator's ranges on rollback.
  const live = {
    id: 31,
    name: 'Cloud Backup',
    description: 'edited in the console',
    group: 'Unclassified',
    cidrs: ['198.51.100.0/24', '192.0.2.0/24'],
  }
  const { calls, restore } = recordFetch([list([live]), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP]))

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), `${LIST_PATH}/31`, 'an update posts to the service id')
    assert.deepEqual(bodyOf(calls[1]), CLOUD_BACKUP_BODY)
    assert.equal(deployStatusCalls(calls).length, 1)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 31)
    assert.deepEqual(entries[0].prior, {
      name: 'Cloud Backup',
      description: 'edited in the console',
      group: 'Unclassified',
      cidrs: ['198.51.100.0/24', '192.0.2.0/24'],
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('remote-services deploy: a deploy that changed nothing does not issue a staged deploy', async () => {
  // POST /staged_config/deploy_status restarts services on the managed hosts.
  // Issuing it on every no-op redeploy would churn a production console.
  const live = {
    id: 31,
    name: 'Cloud Backup',
    description: 'Offsite backup targets',
    group: 'Sanctioned SaaS',
    cidrs: ['203.0.113.0/24', '198.51.100.0/24'],
  }
  const { calls, restore } = recordFetch([list([live])])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP]))

    assert.equal(calls.length, 1, 'an in-sync service is read and left alone')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(deployStatusCalls(calls).length, 0, 'nothing was staged, so nothing needs applying')
    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true, 'a service left alone is still recorded for rollback')
  } finally {
    restore()
  }
})

test('remote-services deploy: a deploy already in progress is success, not a failure', async () => {
  // QRadar's staged deploy is single-flight; a 409 / code 1002 means the
  // in-flight deploy will apply what we just staged. Failing here would mark a
  // perfectly good deploy failed and trigger a needless rollback.
  const { restore } = recordFetch([list([]), created({ id: 55 }), deployInProgress()])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP]))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Deployed 1 remote service/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-services deploy: a rejected staged deploy fails but still returns what it staged', async () => {
  // The service now exists in QRadar's staged config. Dropping the rollbackData
  // here would leave it with nothing to undo.
  const { calls, restore } = recordFetch([list([]), created({ id: 55 }), serverError('Deploy could not be started')])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP]))

    assert.equal(deployStatusCalls(calls).length, 1)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Deploy could not be started/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the created service must still be recoverable')
    assert.equal(entries[0].id, 55)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-services deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { calls, restore } = recordFetch([list([]), qradarError(422, 'A remote service with that name already exists')])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(deployStatusCalls(calls).length, 0, 'nothing was staged, so no deploy is issued')
    const entries = (result.rollbackData as { entries: unknown[] }).entries
    assert.deepEqual(entries, [], 'a service that was never created records no rollback entry')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-services deploy: a rejected update keeps the other services and still applies them', async () => {
  const OTHER = item('Partner VPN', { name: 'Partner VPN', description: '', group: '', cidrs: '192.0.2.0/24' }, 'item-vpn')
  const live = { id: 31, name: 'Cloud Backup', description: 'stale', group: 'Sanctioned SaaS', cidrs: [] }
  const { calls, restore } = recordFetch([
    list([live]),
    qradarError(403, 'You do not have the required capability for this endpoint'),
    created({ id: 66 }),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([CLOUD_BACKUP, OTHER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.name), ['Partner VPN'], 'the failed service records no entry, the created one does')
    assert.equal(deployStatusCalls(calls).length, 1, 'the service that WAS staged still gets applied')
  } finally {
    restore()
  }
})

test('remote-services deploy: matches a renamed service by its recorded id rather than creating a duplicate', async () => {
  // Identity is the name, but a previous deploy wrote the QRadar id down. A
  // rename in the canvas must update that object, not leave the old one behind
  // and create a second overlapping remote service.
  const RENAMED = item(
    'Cloud Backup',
    { name: 'Offsite Backup', description: 'Offsite backup targets', group: 'Sanctioned SaaS', cidrs: '198.51.100.0/24' },
    'item-backup',
  )
  const live = { id: 31, name: 'Cloud Backup', description: 'Offsite backup targets', group: 'Sanctioned SaaS', cidrs: ['198.51.100.0/24'] }
  const { calls, restore } = recordFetch([list([live]), ok({}), ok({})])
  try {
    const result = await deploy(
      deployContext([RENAMED], {
        priorRollbackData: { entries: [{ itemId: 'item-backup', name: 'Cloud Backup', existed: false, id: 31 }] },
      }),
    )

    assert.equal(pathOf(calls[1]), `${LIST_PATH}/31`, 'the recorded id wins over the changed name')
    assert.equal(bodyOf(calls[1])?.name, 'Offsite Backup')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'a rename must not produce a second service')
    assert.equal(entries[0].id, 31)
  } finally {
    restore()
  }
})

test('remote-services deploy: reconcile-deletes only what this app created and no longer declares', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 55 }), ACCEPTED, ok({})])
  try {
    const result = await deploy(
      deployContext([CLOUD_BACKUP], {
        priorRollbackData: {
          entries: [
            { itemId: 'item-retired', name: 'Retired Service', existed: false, id: 8 },
            { itemId: 'item-operator', name: 'Operator Owned', existed: true, id: 9 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${LIST_PATH}/8`])
    assert.equal(
      deletes.includes(`${LIST_PATH}/9`),
      false,
      'a service that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(deployStatusCalls(calls).length, 1)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('remote-services deploy: a reconcile target already gone is not an error', async () => {
  // 404 is a known answer — the object we would delete is already absent, which
  // is the state the reconcile was trying to reach.
  const { restore } = recordFetch([list([]), notFound(), ok({})])
  try {
    const result = await deploy(
      deployContext([], { priorRollbackData: { entries: [{ name: 'Retired Service', existed: false, id: 8 }] } }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('remote-services deploy: an empty canvas writes nothing and stages no deploy', async () => {
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

// NOTE: `listRemoteServices` (deploy.ts:31) returns [] when the list read fails,
// so a 500 there sends every declared service down the CREATE branch. That path
// is deliberately unasserted — a test for it would document the bug as correct.
