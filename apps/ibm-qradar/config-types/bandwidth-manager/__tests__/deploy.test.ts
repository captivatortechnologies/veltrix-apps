// deploy for bandwidth-manager.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the list-then-match flow: ONE range-paged read of the collection, a match by
// previously recorded id and then by lowercased name, POST to `.../{id}` to
// update or to the collection to create, and a rollback entry carrying the LIVE
// prior state. These configurations are store-and-forward traffic-shaping caps
// on a managed host — writing the wrong id, or resetting a cap an operator
// raised for a congested link, throttles forwarding for a whole appliance.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  pathOf,
  qradarError,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const COLLECTION = '/bandwidth_manager/configurations'

const EDGE = item(
  'Edge Cap',
  { name: 'Edge Cap', hostname: 'ep1.example.test', hostId: 3, kbLimit: 5000, deviceName: 'eth0' },
  'itm-edge',
)

registerDeployGuardContract({ label: 'bandwidth-manager', handler: deploy, sampleItems: [EDGE] })

/** A live configuration as `GET /bandwidth_manager/configurations` returns it. */
function liveConfig(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Edge Cap',
    hostname: 'ep1.example.test',
    host_id: 3,
    kb_limit: 5000,
    device_name: 'eth0',
    created_by: 'admin',
    ...over,
  }
}

test('bandwidth-manager deploy: reads the whole collection once, then creates a configuration that is absent', async () => {
  const { calls, restore } = recordFetch([
    list([liveConfig({ id: 1, name: 'Unrelated' })]),
    created({ id: 42, name: 'Edge Cap' }),
  ])
  try {
    const result = await deploy(deployContext([EDGE]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 2, 'one list read, one write')
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), COLLECTION)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole configuration list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), COLLECTION, 'a create posts to the collection, not to an id')
    assert.deepEqual(bodyOf(calls[1]), {
      name: 'Edge Cap',
      host_id: 3,
      hostname: 'ep1.example.test',
      device_name: 'eth0',
      kb_limit: 5000,
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'itm-edge', name: 'Edge Cap', existed: false, id: 42 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: updates a configuration that exists and records the LIVE prior values, not the desired ones', async () => {
  // The live cap was raised by hand in the console and points at another NIC.
  // Recording the canvas values as "prior" would make rollback push the desired
  // cap back rather than restoring the one the deploy replaced.
  const { calls, restore } = recordFetch([
    list([liveConfig({ kb_limit: 20000, device_name: 'eth1' })]),
    ACCEPTED,
  ])
  try {
    const result = await deploy(deployContext([EDGE]))

    assert.equal(calls.length, 2)
    assert.equal(pathOf(calls[1]), `${COLLECTION}/7`, 'an update posts to the matched id')
    assert.deepEqual(bodyOf(calls[1]), {
      name: 'Edge Cap',
      host_id: 3,
      hostname: 'ep1.example.test',
      device_name: 'eth0',
      kb_limit: 5000,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 7)
    assert.deepEqual(
      entries[0].prior,
      { name: 'Edge Cap', hostname: 'ep1.example.test', host_id: 3, kb_limit: 20000, device_name: 'eth1' },
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: writes nothing when the live configuration already matches, but still records rollback state', async () => {
  const { calls, restore } = recordFetch([list([liveConfig()])])
  try {
    const result = await deploy(deployContext([EDGE]))

    assert.equal(writeCalls(calls).length, 0, 'a matching live configuration needs no write')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the configuration is still under management, so rollback must know its state')
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, {
      name: 'Edge Cap',
      hostname: 'ep1.example.test',
      host_id: 3,
      kb_limit: 5000,
      device_name: 'eth0',
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: matches by the recorded id when the configuration was renamed in the console', async () => {
  // Without id matching this creates a SECOND cap on the same managed host, and
  // QRadar then has two shaping rules competing over one link.
  const { calls, restore } = recordFetch([list([liveConfig({ name: 'Renamed In Console' })]), ACCEPTED])
  try {
    const result = await deploy(
      deployContext([EDGE], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'itm-edge',
              name: 'Edge Cap',
              existed: true,
              id: 7,
              prior: {
                name: 'Edge Cap',
                hostname: 'ep1.example.test',
                host_id: 3,
                kb_limit: 5000,
                device_name: 'eth0',
              },
            },
          ],
        },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'exactly one write — an update, not a second create')
    assert.equal(pathOf(writes[0]), `${COLLECTION}/7`)
    assert.equal((bodyOf(writes[0]) ?? {}).name, 'Edge Cap')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].id, 7)
    assert.equal((entries[0].prior as { name: string }).name, 'Renamed In Console')
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: a rejected write is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([list([]), qradarError(422, 'Unknown managed host id')])
  try {
    const result = await deploy(deployContext([EDGE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Unknown managed host id/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: deletes a configuration it created before and no longer declares, never one that pre-existed', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/configurations\/11$/, method: 'DELETE', respond: ACCEPTED },
      { url: /\/configurations$/, method: 'GET', respond: list([liveConfig()]) },
    ],
    ACCEPTED,
  )
  try {
    const result = await deploy(
      deployContext([EDGE], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 11 },
            {
              name: 'Operator Owned',
              existed: true,
              id: 12,
              prior: { name: 'Operator Owned', hostname: 'ep2.example.test', host_id: 4, device_name: 'eth0' },
            },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${COLLECTION}/11`])
    assert.equal(
      deletes.some((p) => p.endsWith('/12')),
      false,
      'a configuration that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: an undeclared host id means all hosts, and an undeclared cap is left out of the body', async () => {
  // -1 is QRadar's "every managed host". Sending nothing, or a null kb_limit,
  // would either be rejected or clear a cap the canvas never claimed to manage.
  const { calls, restore } = recordFetch([list([]), created({ id: 5 })])
  try {
    await deploy(deployContext([item('All Hosts', { name: 'All Hosts', hostname: 'any', deviceName: 'eth0' })]))

    assert.deepEqual(bodyOf(calls[1]), { name: 'All Hosts', host_id: -1, hostname: 'any', device_name: 'eth0' })
  } finally {
    restore()
  }
})

test('bandwidth-manager deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([list([liveConfig()])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})
