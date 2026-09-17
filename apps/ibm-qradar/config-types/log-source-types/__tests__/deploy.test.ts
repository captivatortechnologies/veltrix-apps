// deploy for log-source-types.
//
// The shared contract covers the pre-flight refusals. What is specific here: a
// human declares the default protocol by NAME and deploy resolves it to a
// numeric protocol_type_id against a read-only lookup before writing, so an
// unresolvable name must fail the item rather than write a broken foreign key.
// Two protective guards ride on `internal: true` — a built-in DSM must never be
// modified, and must never be reconcile-deleted.

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
  notFound,
  pathOf,
  qradarError,
  routeFetch,
  writeCalls,
  type CannedResponse,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const TYPES = '/config/event_sources/log_source_management/log_source_types'
const PROTOCOLS = '/config/event_sources/log_source_management/protocol_types'

const SYSLOG = { id: 7, name: 'Syslog' }
const JDBC = { id: 3, name: 'JDBC' }

const ACME = item('Acme Firewall', { name: 'Acme Firewall', defaultProtocolName: 'Syslog' }, 'item-acme')

registerDeployGuardContract({ label: 'log-source-types', handler: deploy, sampleItems: [ACME] })

/** The lookup GET and the resource GET fan out in a `Promise.all`, so the order
 * a queue would impose is an implementation detail — match on URL instead. */
function fakeConsole(opts: {
  protocols?: unknown[]
  types?: unknown[]
  write?: CannedResponse
  remove?: CannedResponse
} = {}) {
  return routeFetch([
    { url: /\/protocol_types/, respond: list(opts.protocols ?? [SYSLOG, JDBC]) },
    { url: /\/log_source_types/, method: 'GET', respond: list(opts.types ?? []) },
    { url: /\/log_source_types/, method: 'POST', respond: opts.write ?? created({ id: 101 }) },
    { url: /\/log_source_types/, method: 'DELETE', respond: opts.remove ?? ACCEPTED },
  ])
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ?? []
}

test('log-source-types deploy: creates a type that does not exist, with the protocol resolved to its id', async () => {
  const { calls, restore } = fakeConsole({ types: [] })
  try {
    const result = await deploy(deployContext([ACME]))

    assertQRadarHeaders(assert, calls)
    const reads = calls.filter((c) => c.method === 'GET')
    assert.ok(reads.some((c) => pathOf(c) === PROTOCOLS), 'the protocol lookup must be read')
    assert.ok(reads.some((c) => pathOf(c) === TYPES))
    assert.ok(reads.every((c) => c.range === 'items=0-9999'), 'the whole list is read, not the first page')

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.equal(pathOf(writes[0]), TYPES)
    assert.deepEqual(bodyOf(writes[0]), { name: 'Acme Firewall', default_protocol_id: 7 })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false, 'a type this deploy created must be marked not pre-existing')
    assert.equal(entries[0].id, 101, 'rollback needs the id the console assigned')
    assert.equal(entries[0].itemId, 'item-acme')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-types deploy: a type with no declared protocol sends no protocol id at all', async () => {
  // The alternative to "no key" is a fabricated one. Sending `default_protocol_id: 0`
  // would repoint the DSM at whatever protocol holds id 0 on that console.
  const { calls, restore } = fakeConsole({ types: [] })
  try {
    await deploy(deployContext([item('Bare Type', { name: 'Bare Type' })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { name: 'Bare Type' })
  } finally {
    restore()
  }
})

test('log-source-types deploy: updating an existing type records the LIVE prior protocol, not the desired one', async () => {
  // The live row deliberately carries a different protocol from the canvas: a
  // handler that recorded the desired value as "prior" would look correct here
  // and roll the DSM back to the value the deploy itself introduced.
  const { calls, restore } = fakeConsole({
    types: [{ id: 44, name: 'Acme Firewall', internal: false, custom: true, default_protocol_id: 3 }],
  })
  try {
    const result = await deploy(deployContext([ACME]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), `${TYPES}/44`, 'an existing type is updated by id, never re-created')
    assert.deepEqual(bodyOf(writes[0]), { name: 'Acme Firewall', default_protocol_id: 7 })

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 44)
    assert.deepEqual(entries[0].prior, { name: 'Acme Firewall', default_protocol_id: 3 })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-types deploy: a type that already matches is not written, but is still recorded', async () => {
  // Rollback can only undo what deploy wrote down. A no-op write still has to
  // leave an entry behind, or a later rollback has nothing to restore.
  const { calls, restore } = fakeConsole({
    types: [{ id: 44, name: 'Acme Firewall', internal: false, default_protocol_id: 7 }],
  })
  try {
    const result = await deploy(deployContext([ACME]))

    assert.equal(writeCalls(calls).length, 0, 'an unchanged type must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, { name: 'Acme Firewall', default_protocol_id: 7 })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-types deploy: refuses to modify a built-in type, without writing', async () => {
  // `internal: true` is IBM's own DSM. Overwriting one changes how every log
  // source of that type parses events, for every tenant on the console, and
  // there is no supported way to put it back.
  const { calls, restore } = fakeConsole({
    types: [{ id: 12, name: 'Acme Firewall', internal: true, default_protocol_id: 3 }],
  })
  try {
    const result = await deploy(deployContext([ACME]))

    assert.equal(writeCalls(calls).length, 0, 'a built-in type must not be touched')
    assert.equal(result.success, false)
    assert.match(String(result.message), /is a built-in log source type and cannot be managed as code/)
    assert.deepEqual(entriesOf(result), [], 'a refused type records no rollback entry')
  } finally {
    restore()
  }
})

test('log-source-types deploy: an unresolvable protocol name fails the item without writing it', async () => {
  // The console answered the lookup perfectly well — the name simply is not in
  // it. Writing anyway would put an undefined foreign key on the DSM.
  const { calls, restore } = fakeConsole({ protocols: [JDBC], types: [] })
  try {
    const result = await deploy(deployContext([ACME]))

    assert.equal(writeCalls(calls).length, 0, 'an unresolved protocol must never reach a write')
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown default protocol "Syslog"/)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('log-source-types deploy: one unresolvable protocol does not stop the rest of the canvas', async () => {
  const OTHER = item('Acme Database', { name: 'Acme Database', defaultProtocolName: 'JDBC' }, 'item-db')
  const { calls, restore } = fakeConsole({ protocols: [JDBC], types: [] })
  try {
    const result = await deploy(deployContext([ACME, OTHER]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'the resolvable item is still deployed')
    assert.deepEqual(bodyOf(writes[0]), { name: 'Acme Database', default_protocol_id: 3 })
    assert.equal(result.success, false)
    assert.equal(entriesOf(result).length, 1)
  } finally {
    restore()
  }
})

test('log-source-types deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { restore } = fakeConsole({ types: [], write: qradarError(422, 'Log source type name is already in use') })
  try {
    const result = await deploy(deployContext([ACME]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already in use/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-types deploy: deletes a type it created before and no longer declares', async () => {
  const { calls, restore } = fakeConsole({
    types: [
      { id: 91, name: 'Retired DSM', internal: false },
      { id: 92, name: 'Operator Owned', internal: false },
    ],
  })
  try {
    const result = await deploy(
      deployContext([ACME], {
        priorRollbackData: {
          entries: [
            { itemId: 'item-old', name: 'Retired DSM', existed: false, id: 91 },
            { itemId: 'item-op', name: 'Operator Owned', existed: true, id: 92 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${TYPES}/91`])
    assert.equal(
      deletes.some((p) => p.endsWith('/92')),
      false,
      'a type that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-types deploy: never reconcile-deletes a prior entry whose live row is built-in', async () => {
  // An id that now resolves to an IBM DSM is the worst possible delete: it is
  // not recoverable from here, and it breaks parsing for every log source using
  // it. "Recorded as ours" is not enough — the live row decides.
  const { calls, restore } = fakeConsole({
    types: [{ id: 60, name: 'Shadowed', internal: true }],
  })
  try {
    const result = await deploy(
      deployContext([ACME], {
        priorRollbackData: { entries: [{ name: 'Shadowed', existed: false, id: 60 }] },
      }),
    )

    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'a built-in type must never be deleted')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-types deploy: a 202 or 404 on a reconcile delete is not a failure', async () => {
  // 202 is QRadar accepting an asynchronous delete and 404 means the object is
  // already gone — both are the state the reconcile was trying to reach.
  for (const answer of [ACCEPTED, notFound()]) {
    const { restore } = fakeConsole({ types: [], remove: answer })
    try {
      const result = await deploy(
        deployContext([ACME], {
          priorRollbackData: { entries: [{ name: 'Retired DSM', existed: false, id: 91 }] },
        }),
      )

      assert.equal(result.success, true, `status ${answer.status} must not read as a failed delete`)
    } finally {
      restore()
    }
  }
})

test('log-source-types deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = fakeConsole({ types: [] })
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})
