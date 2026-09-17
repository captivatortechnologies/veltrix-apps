// deploy for tenants.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the list-then-match flow: ONE range-paged read of the collection, a match by
// previously recorded id and then by lowercased name, POST to `.../{id}` to
// update or to the collection to create, and a rollback entry carrying the LIVE
// prior state. A tenant carries the MSSP data-separation boundary and its own
// event/flow rate caps — overwriting the wrong tenant, or silently resetting a
// cap an operator raised, throttles a customer's ingest.

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

const COLLECTION = '/config/access/tenant_management/tenants'

const RESEARCH = item(
  'Research',
  { name: 'Research', description: 'Research business unit', eventRateLimit: 5000, flowRateLimit: 2500 },
  'itm-research',
)

registerDeployGuardContract({ label: 'tenants', handler: deploy, sampleItems: [RESEARCH] })

/** A live tenant as `GET /config/access/tenant_management/tenants` returns it. */
function liveTenant(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Research',
    description: 'Research business unit',
    event_rate_limit: 5000,
    flow_rate_limit: 2500,
    deleted: false,
    ...over,
  }
}

test('tenants deploy: reads the whole collection once, then creates a tenant that is absent', async () => {
  const { calls, restore } = recordFetch([
    list([liveTenant({ id: 1, name: 'Unrelated' })]),
    created({ id: 42, name: 'Research' }),
  ])
  try {
    const result = await deploy(deployContext([RESEARCH]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 2, 'one list read, one write')
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), COLLECTION)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole tenant list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), COLLECTION, 'a create posts to the collection, not to an id')
    assert.deepEqual(bodyOf(calls[1]), {
      name: 'Research',
      description: 'Research business unit',
      event_rate_limit: 5000,
      flow_rate_limit: 2500,
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'itm-research', name: 'Research', existed: false, id: 42 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tenants deploy: updates a tenant that exists and records the LIVE prior values, not the desired ones', async () => {
  // The live tenant was edited by hand: a different description and a rate cap
  // an operator raised. Recording the canvas values as "prior" would make
  // rollback push the desired cap back instead of the one it replaced.
  const { calls, restore } = recordFetch([
    list([liveTenant({ description: 'edited by hand in the console', event_rate_limit: 9000 })]),
    ACCEPTED,
  ])
  try {
    const result = await deploy(deployContext([RESEARCH]))

    assert.equal(calls.length, 2)
    assert.equal(pathOf(calls[1]), `${COLLECTION}/7`, 'an update posts to the matched id')
    assert.deepEqual(bodyOf(calls[1]), {
      name: 'Research',
      description: 'Research business unit',
      event_rate_limit: 5000,
      flow_rate_limit: 2500,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 7)
    assert.deepEqual(
      entries[0].prior,
      {
        name: 'Research',
        description: 'edited by hand in the console',
        eventRateLimit: 9000,
        flowRateLimit: 2500,
      },
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tenants deploy: writes nothing when the live tenant already matches, but still records rollback state', async () => {
  const { calls, restore } = recordFetch([list([liveTenant()])])
  try {
    const result = await deploy(deployContext([RESEARCH]))

    assert.equal(writeCalls(calls).length, 0, 'a matching live tenant needs no write')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the tenant is still under management, so rollback must know its state')
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, {
      name: 'Research',
      description: 'Research business unit',
      eventRateLimit: 5000,
      flowRateLimit: 2500,
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tenants deploy: matches by the recorded id when the tenant was renamed in the console', async () => {
  // Without id matching this creates a SECOND tenant, and the domains and log
  // sources already scoped to the original stay attached to a tenant the canvas
  // no longer controls.
  const { calls, restore } = recordFetch([list([liveTenant({ name: 'Renamed In Console' })]), ACCEPTED])
  try {
    const result = await deploy(
      deployContext([RESEARCH], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'itm-research',
              name: 'Research',
              existed: true,
              id: 7,
              prior: { name: 'Research', description: 'Research business unit' },
            },
          ],
        },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'exactly one write — an update, not a second create')
    assert.equal(pathOf(writes[0]), `${COLLECTION}/7`)
    assert.equal((bodyOf(writes[0]) ?? {}).name, 'Research')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].id, 7)
    assert.equal((entries[0].prior as { name: string }).name, 'Renamed In Console')
  } finally {
    restore()
  }
})

test('tenants deploy: a soft-deleted tenant is not treated as existing', async () => {
  // QRadar tombstones tenants rather than removing the row. Reusing a deleted
  // row's id would resurrect a tenant an operator deliberately retired, together
  // with whatever data separation it carried.
  const { calls, restore } = recordFetch([list([liveTenant({ id: 9, deleted: true })]), created({ id: 42 })])
  try {
    const result = await deploy(deployContext([RESEARCH]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), COLLECTION, 'a tombstoned row must be created afresh, not updated')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 42)
  } finally {
    restore()
  }
})

test('tenants deploy: a rejected write is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([list([]), qradarError(422, 'Tenant name is already in use')])
  try {
    const result = await deploy(deployContext([RESEARCH]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already in use/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tenants deploy: deletes a tenant it created before and no longer declares, never one that pre-existed', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/tenants\/11$/, method: 'DELETE', respond: ACCEPTED },
      { url: /\/tenants$/, method: 'GET', respond: list([liveTenant()]) },
    ],
    ACCEPTED,
  )
  try {
    const result = await deploy(
      deployContext([RESEARCH], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 11 },
            { name: 'Operator Owned', existed: true, id: 12, prior: { name: 'Operator Owned', description: 'theirs' } },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${COLLECTION}/11`])
    assert.equal(
      deletes.some((p) => p.endsWith('/12')),
      false,
      'a tenant that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tenants deploy: omits the rate limits from the body when the canvas declares none', async () => {
  // Sending `event_rate_limit: null` for an undeclared cap would clear a limit
  // the canvas never claimed to manage.
  const { calls, restore } = recordFetch([list([]), created({ id: 5 })])
  try {
    await deploy(deployContext([item('Minimal', { name: 'Minimal', description: 'No caps' })]))

    assert.deepEqual(bodyOf(calls[1]), { name: 'Minimal', description: 'No caps' })
  } finally {
    restore()
  }
})

test('tenants deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([list([liveTenant()])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})
