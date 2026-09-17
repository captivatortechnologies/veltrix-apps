// deploy for domains.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the list-then-match flow this family of config types shares: ONE range-paged
// read of the collection, a match by previously recorded id and then by
// lowercased name, POST to `.../{id}` to update or to the collection to create,
// and a rollback entry carrying the LIVE prior state. Domains are the tenancy
// boundary in QRadar — overwriting the wrong one, or creating a duplicate
// alongside one that already exists, mis-scopes every event routed through it.

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
  serverError,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const COLLECTION = '/config/domain_management/domains'

const CORP = item('Corp', { name: 'Corp', description: 'Corporate network' }, 'itm-corp')

registerDeployGuardContract({ label: 'domains', handler: deploy, sampleItems: [CORP] })

/** A live domain as `GET /config/domain_management/domains` returns it. */
function liveDomain(over: Record<string, unknown> = {}) {
  return { id: 7, name: 'Corp', description: 'Corporate network', deleted: false, ...over }
}

test('domains deploy: reads the whole collection once, then creates a domain that is absent', async () => {
  const { calls, restore } = recordFetch([
    list([liveDomain({ id: 1, name: 'Unrelated', description: '' })]),
    created({ id: 42, name: 'Corp', description: 'Corporate network' }),
  ])
  try {
    const result = await deploy(deployContext([CORP]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 2, 'one list read, one write')
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), COLLECTION)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole domain list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), COLLECTION, 'a create posts to the collection, not to an id')
    assert.deepEqual(bodyOf(calls[1]), { name: 'Corp', description: 'Corporate network' })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'itm-corp', name: 'Corp', existed: false, id: 42 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('domains deploy: updates a domain that exists and records the LIVE prior values, not the desired ones', async () => {
  // The live description was edited by hand in the console. Recording the canvas
  // values as "prior" would look right on a no-op deploy and would overwrite the
  // operator's edit with the desired value on rollback instead of restoring it.
  const { calls, restore } = recordFetch([
    list([liveDomain({ description: 'edited by hand in the console' })]),
    ACCEPTED,
  ])
  try {
    const result = await deploy(deployContext([CORP]))

    assert.equal(calls.length, 2)
    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), `${COLLECTION}/7`, 'an update posts to the matched id')
    assert.deepEqual(bodyOf(calls[1]), { name: 'Corp', description: 'Corporate network' })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 7)
    assert.deepEqual(
      entries[0].prior,
      { name: 'Corp', description: 'edited by hand in the console' },
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('domains deploy: writes nothing when the live domain already matches, but still records rollback state', async () => {
  // A no-op deploy that re-POSTed every domain would churn the console's audit
  // log and risk a rejection for a resource nothing asked to change.
  const { calls, restore } = recordFetch([list([liveDomain()])])
  try {
    const result = await deploy(deployContext([CORP]))

    assert.equal(writeCalls(calls).length, 0, 'a matching live domain needs no write')
    assert.equal(calls.length, 1)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the domain is still under management, so rollback must know its state')
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, { name: 'Corp', description: 'Corporate network' })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('domains deploy: matches by the recorded id when the domain was renamed in the console', async () => {
  // Without id matching this creates a SECOND domain alongside the renamed one,
  // and the events scoped to the original keep flowing to an object the canvas
  // no longer controls.
  const { calls, restore } = recordFetch([
    list([liveDomain({ id: 7, name: 'Renamed In Console', description: 'Corporate network' })]),
    ACCEPTED,
  ])
  try {
    const result = await deploy(
      deployContext([CORP], {
        priorRollbackData: {
          entries: [
            { itemId: 'itm-corp', name: 'Corp', existed: true, id: 7, prior: { name: 'Corp', description: 'Corporate network' } },
          ],
        },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'exactly one write — an update, not a second create')
    assert.equal(pathOf(writes[0]), `${COLLECTION}/7`)
    assert.deepEqual(bodyOf(writes[0]), { name: 'Corp', description: 'Corporate network' })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].id, 7)
    assert.deepEqual(entries[0].prior, { name: 'Renamed In Console', description: 'Corporate network' })
  } finally {
    restore()
  }
})

test('domains deploy: a soft-deleted domain is not treated as existing', async () => {
  // QRadar tombstones domains rather than removing the row. Reusing a deleted
  // row's id would POST an update the console rejects (or silently resurrect a
  // domain an operator deliberately retired).
  const { calls, restore } = recordFetch([
    list([liveDomain({ id: 9, deleted: true })]),
    created({ id: 42, name: 'Corp' }),
  ])
  try {
    const result = await deploy(deployContext([CORP]))

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

test('domains deploy: refuses to write when it could not read what already exists', async () => {
  // The listing used to return [] on any non-2xx, so a transient 500 made the
  // deploy take the CREATE branch for domains that already exist. For the
  // append-only QRadar types that is permanent — there is no delete endpoint.
  const { calls, restore } = recordFetch([serverError('Console is restarting')])
  try {
    const result = await deploy(deployContext([CORP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Could not read the existing domains/)
    assert.equal(writeCalls(calls).length, 0, 'an unreadable console is not an empty one')
  } finally {
    restore()
  }
})

test('domains deploy: a rejected write is a failed result, not a thrown error', async () => {
  // A handler that throws surfaces as an opaque pipeline crash instead of the
  // console's own message, which is the only thing that tells the operator why.
  const { restore } = recordFetch([list([]), qradarError(422, 'Domain name is already in use')])
  try {
    const result = await deploy(deployContext([CORP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already in use/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('domains deploy: deletes a domain it created before and no longer declares, never one that pre-existed', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/domains\/11$/, method: 'DELETE', respond: ACCEPTED },
      { url: /\/domains$/, method: 'GET', respond: list([liveDomain()]) },
    ],
    ACCEPTED,
  )
  try {
    const result = await deploy(
      deployContext([CORP], {
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
      'a domain that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('domains deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([list([liveDomain()])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('domains deploy: reads the canvas item name when no name field is set', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 5 })])
  try {
    await deploy(deployContext([item('Fallback Name', { description: 'from the item name' })]))

    assert.deepEqual(bodyOf(calls[1]), { name: 'Fallback Name', description: 'from the item name' })
  } finally {
    restore()
  }
})
