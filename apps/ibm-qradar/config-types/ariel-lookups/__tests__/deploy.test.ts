// deploy for ariel-lookups.
//
// The shared contract covers the pre-flight refusals. What is specific here: the
// lookup NAME is the identity and it goes in the URL path, the value type is
// immutable, and the canvas's `key=value` lines have to become a plain key→value
// JSON object — QRadar rejects anything else, and an update carries only
// `{ default_value, map }`.

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
  routeFetch,
  writeCalls,
  type CannedResponse,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/ariel/lookups'

const DEPARTMENTS = item(
  'department_lookup',
  {
    name: 'department_lookup',
    type: 'String',
    defaultValue: 'unknown',
    entries: 'hr=Human Resources\nfin=Finance',
  },
  'item-dept',
)

/** The live lookup as `GET /ariel/lookups` returns it, before per-test edits. */
function liveLookup(over: Record<string, unknown> = {}) {
  return {
    name: 'department_lookup',
    type: 'String',
    default_value: 'unknown',
    map: { hr: 'Human Resources', fin: 'Finance' },
    ...over,
  }
}

registerDeployGuardContract({ label: 'ariel-lookups', handler: deploy, sampleItems: [DEPARTMENTS] })

function fakeConsole(opts: { lookups?: unknown[]; write?: CannedResponse; remove?: CannedResponse } = {}) {
  return routeFetch([
    { url: /\/ariel\/lookups/, method: 'GET', respond: list(opts.lookups ?? []) },
    { url: /\/ariel\/lookups/, method: 'POST', respond: opts.write ?? created({ name: 'department_lookup' }) },
    { url: /\/ariel\/lookups/, method: 'DELETE', respond: opts.remove ?? ACCEPTED },
  ])
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ?? []
}

test('ariel-lookups deploy: creates a lookup that does not exist, with the lines as a key→value map', async () => {
  const { calls, restore } = fakeConsole({ lookups: [] })
  try {
    const result = await deploy(deployContext([DEPARTMENTS]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), PATH, 'a create posts to the collection, not to the name')
    assert.deepEqual(bodyOf(writes[0]), {
      name: 'department_lookup',
      type: 'String',
      default_value: 'unknown',
      map: { hr: 'Human Resources', fin: 'Finance' },
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].name, 'department_lookup')
    assert.deepEqual(entries[0].priorEntries, [])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: a value containing "=" keeps everything after the first separator', async () => {
  // The first '=' splits key from value, so a value that itself contains one
  // must survive intact — losing the tail would silently change the mapping.
  const { calls, restore } = fakeConsole({ lookups: [] })
  try {
    await deploy(
      deployContext([item('kv', { name: 'kv', type: 'String', entries: 'url=https://host/path?a=b' })]),
    )

    assert.deepEqual((bodyOf(writeCalls(calls)[0]) as Record<string, unknown>).map, {
      url: 'https://host/path?a=b',
    })
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: updating an existing lookup addresses it by name and sends only the two mutable fields', async () => {
  // The live lookup deliberately differs from the canvas in both directions: it
  // is missing a declared key and carries one the canvas does not declare.
  const { calls, restore } = fakeConsole({
    lookups: [liveLookup({ default_value: 'unassigned', map: { hr: 'Human Resources', legacy: 'Legacy Dept' } })],
  })
  try {
    const result = await deploy(deployContext([DEPARTMENTS]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), `${PATH}/department_lookup`, 'the name is the identity in the path')
    assert.deepEqual(
      bodyOf(writes[0]),
      { default_value: 'unknown', map: { hr: 'Human Resources', fin: 'Finance' } },
      'the map replaces the live one wholesale — the type and name are not resent',
    )

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].priorDefaultValue, 'unassigned', 'rollback state is what was live before the write')
    assert.deepEqual(entries[0].priorEntries, [
      { key: 'hr', value: 'Human Resources' },
      { key: 'legacy', value: 'Legacy Dept' },
    ])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: a lookup name with a space is URL-encoded in the path', async () => {
  const SPACED = item('Department Lookup', { name: 'Department Lookup', type: 'String', entries: 'hr=HR' })
  const { calls, restore } = fakeConsole({
    lookups: [liveLookup({ name: 'Department Lookup', map: {}, default_value: '' })],
  })
  try {
    await deploy(deployContext([SPACED]))

    assert.equal(pathOf(writeCalls(calls)[0]), `${PATH}/Department%20Lookup`)
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: a lookup that already matches is not written, but is still recorded', async () => {
  const { calls, restore } = fakeConsole({ lookups: [liveLookup()] })
  try {
    const result = await deploy(deployContext([DEPARTMENTS]))

    assert.equal(writeCalls(calls).length, 0, 'an unchanged lookup must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'rollback still needs to know the lookup was under management')
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: refuses a lookup whose live field type differs, without writing', async () => {
  // The type is immutable in QRadar. Pushing String values into an Integer
  // lookup would be rejected per key, leaving a half-populated map behind.
  const { calls, restore } = fakeConsole({ lookups: [liveLookup({ type: 'Integer' })] })
  try {
    const result = await deploy(deployContext([DEPARTMENTS]))

    assert.equal(writeCalls(calls).length, 0, 'an immutable-type clash must not write anything')
    assert.equal(result.success, false)
    assert.match(String(result.message), /the type is immutable/)
    assert.deepEqual(entriesOf(result), [], 'a refused lookup records no rollback entry')
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { restore } = fakeConsole({
    lookups: [],
    write: qradarError(422, 'Lookup name contains characters that are not allowed'),
  })
  try {
    const result = await deploy(deployContext([DEPARTMENTS]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not allowed/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: deletes a lookup it created before and no longer declares', async () => {
  const { calls, restore } = fakeConsole({ lookups: [] })
  try {
    const result = await deploy(
      deployContext([DEPARTMENTS], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Lookup', existed: false, type: 'String' },
            { name: 'operator_owned', existed: true, type: 'String' },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${PATH}/Retired%20Lookup`])
    assert.equal(
      deletes.some((p) => p.includes('operator_owned')),
      false,
      'a lookup that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-lookups deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = fakeConsole({ lookups: [] })
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})
