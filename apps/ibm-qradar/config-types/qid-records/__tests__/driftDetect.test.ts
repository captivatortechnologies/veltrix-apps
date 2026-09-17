// driftDetect for qid-records.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the low level category is declared by NAME, so drift has to
// resolve it before it can compare anything — the live record only carries the
// numeric id. A record re-categorised in the console changes which rules fire on
// those events, which is why the comparison exists at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  list,
  pathOf,
  routeFetch,
  writeCalls,
  type CannedResponse,
  type Route,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const QID = '/data_classification/qid_records'
const BY_NAME = `${QID}?filter=name%3D%22Failed%20Login%22`

const LOGIN_FAILURE = { id: 3117, name: 'User Login Failure' }
const AUTH_FAILED = { id: 3118, name: 'General Authentication Failed' }

const FAILED_LOGIN = item('Failed Login', {
  logSourceType: 'Linux OS',
  name: 'Failed Login',
  description: 'Authentication failure',
  lowLevelCategory: 'User Login Failure',
  severity: 7,
  eventMappings: '[{"eventId":"4625","eventCategory":"Security"}]',
})

registerDriftGuardContract({ label: 'qid-records', handler: driftDetect, sampleItems: [FAILED_LOGIN] })

function routes(over: { categories?: CannedResponse; byName?: CannedResponse } = {}): Route[] {
  return [
    { url: /\/low_level_categories$/, respond: over.categories ?? list([LOGIN_FAILURE, AUTH_FAILED]) },
    { url: /\/qid_records\?filter=/, method: 'GET', respond: over.byName ?? list([]) },
  ]
}

function liveRecord(over: Record<string, unknown> = {}) {
  return {
    id: 7001,
    name: 'Failed Login',
    description: 'Authentication failure',
    severity: 7,
    low_level_category_id: 3117,
    log_source_type_id: 11,
    ...over,
  }
}

test('qid-records driftDetect: reports in sync when the live record matches', async () => {
  const { calls, restore } = routeFetch(routes({ byName: list([liveRecord()]) }))
  try {
    const result = await driftDetect(driftContext([FAILED_LOGIN]))

    const lookup = calls.find((c) => pathOf(c) === BY_NAME)
    assert.ok(lookup, `expected a filtered read of ${BY_NAME}`)
    assert.equal(lookup.range, 'items=0-99')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('qid-records driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`; a handler reading it would
  // query for a record that was never deployed and report it missing.
  const { calls, restore } = routeFetch(routes({ byName: list([liveRecord()]) }))
  try {
    const result = await driftDetect(driftContext([FAILED_LOGIN]))

    assert.ok(calls.some((c) => pathOf(c) === BY_NAME))
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('qid-records driftDetect: reports a record the console no longer holds as critical', async () => {
  const { restore } = routeFetch(routes({ byName: list([]) }))
  try {
    const result = await driftDetect(driftContext([FAILED_LOGIN]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Failed Login', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an empty result set is an answer, so the run did check')
  } finally {
    restore()
  }
})

test('qid-records driftDetect: reports a record re-categorised in the console', async () => {
  const { restore } = routeFetch(routes({ byName: list([liveRecord({ low_level_category_id: 3118 })]) }))
  try {
    const result = await driftDetect(driftContext([FAILED_LOGIN]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Failed Login.lowLevelCategory')
    assert.ok(diff, `expected a category diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'User Login Failure')
    assert.equal(diff.actual, '3118')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('qid-records driftDetect: reports a severity changed in the console', async () => {
  const { restore } = routeFetch(routes({ byName: list([liveRecord({ severity: 2 })]) }))
  try {
    const result = await driftDetect(driftContext([FAILED_LOGIN]))

    const diff = result.diffs.find((d) => d.field === 'Failed Login.severity')
    assert.ok(diff)
    assert.equal(diff.expected, '7')
    assert.equal(diff.actual, '2')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('qid-records driftDetect: an unresolvable category name is not reported as a category change', async () => {
  // The category lookup no longer carries the declared name, so there is no id
  // to compare against. Emitting a diff here would blame the console for a
  // difference the run never established.
  const { restore } = routeFetch(routes({ categories: list([AUTH_FAILED]), byName: list([liveRecord()]) }))
  try {
    const result = await driftDetect(driftContext([FAILED_LOGIN]))

    assert.equal(
      result.diffs.some((d) => d.field === 'Failed Login.lowLevelCategory'),
      false,
    )
  } finally {
    restore()
  }
})

test('qid-records driftDetect: an empty deployed config compares nothing and reports in sync', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(
      calls.some((c) => pathOf(c).startsWith(`${QID}?filter=`)),
      false,
      'nothing was deployed, so there is nothing to look up',
    )
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})
