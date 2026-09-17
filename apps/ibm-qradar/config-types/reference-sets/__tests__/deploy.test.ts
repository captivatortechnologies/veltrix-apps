// deploy for reference-sets.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the classic name-keyed reference-data flow: GET the set by name, create it on
// a 404, reconcile its values to exactly the declared list, and record the LIVE
// prior values so rollback can put them back. The element type is immutable, so
// a live type mismatch must refuse rather than overwrite.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  canvas,
  deployContext,
  item,
  leaksToken,
  list,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const BLOCKED = item('Blocked Domains', {
  name: 'Blocked Domains',
  elementType: 'ALN',
  values: 'evil.example\nbad.example',
})

registerDeployGuardContract({ label: 'reference-sets', handler: deploy, sampleItems: [BLOCKED] })

/** A live set as `GET /reference_data/sets/{name}` returns it. */
function liveSet(name: string, elementType: string, values: string[]) {
  return ok({ name, element_type: elementType, number_of_elements: values.length, data: values.map((value) => ({ value })) })
}

test('reference-sets deploy: creates a set that does not exist and records it as created', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([BLOCKED]))

    assertQRadarHeaders(assert, calls)
    assert.equal(pathOf(calls[0]), '/reference_data/sets/Blocked%20Domains', 'the set name is URL-encoded')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].range, 'items=0-9999', 'the whole value list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), '/reference_data/sets?name=Blocked%20Domains&element_type=ALN')
    assert.deepEqual(
      calls.slice(2).map((c) => pathOf(c)),
      [
        '/reference_data/sets/Blocked%20Domains?value=evil.example',
        '/reference_data/sets/Blocked%20Domains?value=bad.example',
      ],
    )

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Blocked Domains')
    assert.equal(entries[0].existed, false, 'a set this deploy created must be marked not pre-existing')
    assert.deepEqual(entries[0].priorValues, [])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-sets deploy: updating an existing set records the LIVE prior values, not the desired ones', async () => {
  // The live set deliberately differs from the canvas in BOTH directions: it is
  // missing one declared value and carries one the canvas does not declare. A
  // handler that recorded the canvas values as "prior" would look correct on a
  // no-op deploy and lose the operator's data on rollback.
  const { calls, restore } = recordFetch([
    liveSet('Blocked Domains', 'ALN', ['evil.example', 'added-by-hand.example']),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([BLOCKED]))

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/sets/Blocked%20Domains?value=bad.example',
        'DELETE /reference_data/sets/Blocked%20Domains/added-by-hand.example',
      ],
      'reconcile adds what is missing and removes what is extra',
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.deepEqual(
      entries[0].priorValues,
      ['evil.example', 'added-by-hand.example'],
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-sets deploy: refuses a set whose live element type differs, without writing', async () => {
  // The element type is immutable in QRadar; reconciling IP values into an ALN
  // set would half-succeed and leave a mixed set behind.
  const { calls, restore } = recordFetch([liveSet('Blocked Domains', 'IP', ['10.0.0.1'])])
  try {
    const result = await deploy(deployContext([BLOCKED]))

    assert.equal(writeCalls(calls).length, 0, 'an immutable-type clash must not write anything')
    assert.equal(result.success, false)
    assert.match(String(result.message), /element type is immutable/)
    const entries = (result.rollbackData as { entries: unknown[] }).entries
    assert.deepEqual(entries, [], 'a refused set records no rollback entry')
  } finally {
    restore()
  }
})

test('reference-sets deploy: an unreadable set fails rather than being created a second time', async () => {
  // A 500 means "I do not know whether this set exists". Treating it as 404 and
  // creating would either collide or duplicate; this asserts the handler makes
  // no create attempt at all.
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await deploy(deployContext([BLOCKED]))

    assert.equal(calls.length, 1, 'the handler stops at the failed read')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-sets deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([notFound(), qradarError(422, 'Reference set name contains invalid characters')])
  try {
    const result = await deploy(deployContext([BLOCKED]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid characters/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-sets deploy: a value the console rejects fails the deploy but keeps the rollback entry', async () => {
  const { restore } = recordFetch([
    liveSet('Blocked Domains', 'ALN', ['evil.example']),
    qradarError(422, 'Value does not match the element type'),
  ])
  try {
    const result = await deploy(deployContext([BLOCKED]))

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the set was touched, so rollback must know its prior state')
    assert.deepEqual(entries[0].priorValues, ['evil.example'])
  } finally {
    restore()
  }
})

test('reference-sets deploy: removes a set it created before and no longer declares', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/reference_data\/sets\/Blocked%20Domains$/, method: 'GET', respond: notFound() },
      { url: /\/reference_data\/sets\?name=/, method: 'POST', respond: ok({}) },
      { url: /\/reference_data\/sets\/Retired%20Set$/, method: 'DELETE', respond: ACCEPTED },
    ],
    ok({}),
  )
  try {
    const result = await deploy(
      deployContext([BLOCKED], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Set', existed: false, elementType: 'ALN', priorValues: [] },
            { name: 'Operator Owned', existed: true, elementType: 'ALN', priorValues: ['x'] },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, ['/reference_data/sets/Retired%20Set'])
    assert.equal(
      deletes.some((p) => p.includes('Operator%20Owned')),
      false,
      'a set that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-sets deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('reference-sets deploy: reads the canvas item name when no name field is set', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    await deploy(deployContext([item('Fallback Name', { elementType: 'aln', values: ['one'] })]))

    assert.equal(pathOf(calls[0]), '/reference_data/sets/Fallback%20Name')
    assert.equal(
      pathOf(calls[1]),
      '/reference_data/sets?name=Fallback%20Name&element_type=ALN',
      'the element type is upper-cased before it is sent',
    )
  } finally {
    restore()
  }
})

test('reference-sets deploy: canvas snapshots that carry only `sections` are read too', async () => {
  // The platform still ships the deprecated `sections` alias; the extractor
  // falls back to it, and a fixture that only sets `items` would never prove it.
  const ctx = deployContext([])
  const sectionsOnly = { ...canvas([BLOCKED]), items: undefined as unknown as [] }
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({})])
  try {
    await deploy({ ...ctx, canvas: sectionsOnly } as typeof ctx)

    assert.ok(calls.length > 0, 'a sections-only canvas must still deploy')
    assert.equal(pathOf(calls[0]), '/reference_data/sets/Blocked%20Domains')
  } finally {
    restore()
  }
})
