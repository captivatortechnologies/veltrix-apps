// deploy for offense-closing-reasons.
//
// The shared contract covers the pre-flight refusals. Two things are specific
// here. First, the create takes the reason text as a QUERY PARAMETER and sends
// no body at all — a handler that "helpfully" posted JSON would have QRadar
// create a reason named `null`, permanently, because there is no delete. Second,
// the type is APPEND-ONLY: a reason that already exists must be recorded with no
// write, and a soft-deleted (`is_deleted`) row must NOT count as existing.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  created,
  deployContext,
  item,
  leaksToken,
  list,
  pathOf,
  qradarError,
  recordFetch,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/siem/offense_closing_reasons'

const TUNED = item('False Positive - Tuned', { text: 'False Positive - Tuned' }, 'item-tuned')

registerDeployGuardContract({ label: 'offense-closing-reasons', handler: deploy, sampleItems: [TUNED] })

test('offense-closing-reasons deploy: creates a missing reason as a query parameter with no body', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 40, text: 'False Positive - Tuned' })])
  try {
    const result = await deploy(deployContext([TUNED]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    assert.equal(calls.length, 2)
    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), `${PATH}?reason=False%20Positive%20-%20Tuned`)
    assert.equal(calls[1].body, '', 'the reason travels in the query string; there is no request body')
    assert.equal(calls[1].contentType, null, 'a body-less POST must not announce a JSON content type')

    assert.equal(result.success, true)
    assert.match(String(result.message), /Ensured 1 closing reason\(s\) \(1 created\)/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'item-tuned', text: 'False Positive - Tuned', existed: false, id: 40 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: URL-encodes a reason containing separators', async () => {
  // An unencoded `&` would truncate the reason at the ampersand and create the
  // wrong text — which, with no delete endpoint, is permanent.
  const AMPERSAND = item('Closed: duplicate & noise', { text: 'Closed: duplicate & noise' }, 'item-dup')
  const { calls, restore } = recordFetch([list([]), created({ id: 41 })])
  try {
    await deploy(deployContext([AMPERSAND]))

    assert.equal(pathOf(calls[1]), `${PATH}?reason=Closed%3A%20duplicate%20%26%20noise`)
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: a reason that already exists is recorded as existing with NO write', async () => {
  // There is no update or delete endpoint, so posting again would leave a
  // duplicate reason in the analyst's close dialog forever.
  const { calls, restore } = recordFetch([list([{ id: 7, text: 'False Positive - Tuned' }])])
  try {
    const result = await deploy(deployContext([TUNED]))

    assert.equal(calls.length, 1, 'an existing reason is read and left alone')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /\(0 created\)/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'item-tuned', text: 'False Positive - Tuned', existed: true, id: 7 }])
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: matches an existing reason case-insensitively', async () => {
  const { calls, restore } = recordFetch([list([{ id: 7, text: 'FALSE POSITIVE - TUNED' }])])
  try {
    const result = await deploy(deployContext([TUNED]))

    assert.equal(writeCalls(calls).length, 0, 'a case difference must not create a second reason')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: a soft-deleted reason does not count as existing', async () => {
  // QRadar keeps retired reasons in the list with `is_deleted: true`. Treating
  // one as present would leave the canvas's reason permanently unavailable to
  // analysts while the deploy reported success.
  const { calls, restore } = recordFetch([list([{ id: 7, text: 'False Positive - Tuned', is_deleted: true }]), created({ id: 40 })])
  try {
    const result = await deploy(deployContext([TUNED]))

    assert.equal(calls.length, 2, 'a retired reason must be re-created')
    assert.equal(pathOf(calls[1]), `${PATH}?reason=False%20Positive%20-%20Tuned`)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 40, 'the entry carries the NEW id, not the soft-deleted one')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: a rejected create is a failed result that keeps what succeeded', async () => {
  const OTHER = item('Closed by automation', { text: 'Closed by automation' }, 'item-auto')
  const { restore } = recordFetch([
    list([{ id: 7, text: 'False Positive - Tuned' }]),
    qradarError(422, 'Closing reason text must be between 5 and 60 characters'),
  ])
  try {
    const result = await deploy(deployContext([TUNED, OTHER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /between 5 and 60 characters/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.text), ['False Positive - Tuned'], 'the reason already present stays recorded')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: a create the console accepts without an id still records an entry', async () => {
  // The reason exists in QRadar either way. Dropping the entry because the id
  // was unreadable would hide it from the append-only rollback report.
  const { restore } = recordFetch([list([]), created({ text: 'False Positive - Tuned' })])
  try {
    const result = await deploy(deployContext([TUNED]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, undefined)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('offense-closing-reasons deploy: falls back to the canvas item name when no text field is set', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 42 })])
  try {
    await deploy(deployContext([item('Closed by policy', {}, 'item-policy')]))

    assert.equal(pathOf(calls[1]), `${PATH}?reason=Closed%20by%20policy`)
  } finally {
    restore()
  }
})

// NOTE: `listClosingReasons` (deploy.ts:25) returns [] when the list read fails,
// so a 500 there sends every declared reason down the CREATE branch — and with
// no delete endpoint those duplicates are permanent. That path is deliberately
// unasserted: a test for it would document the bug as correct.
