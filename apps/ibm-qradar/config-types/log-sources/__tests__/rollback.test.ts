// rollback for log-sources.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: a source this deploy created is deleted outright, and a
// source it only updated is re-posted with the body deploy captured BEFORE the
// write — including the operator's own protocol parameters. An entry missing its
// id or its prior body has nothing safe to send, and must therefore send
// nothing rather than invent a value.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

registerRollbackGuardContract({ label: 'log-sources', handler: rollback })

const LS = '/config/event_sources/log_source_management/log_sources'

/** What the operator had before the deploy overwrote it. */
const PRIOR_BODY = {
  name: 'Perimeter Firewall',
  type_id: 11,
  protocol_type_id: 7,
  protocol_parameters: [
    { id: 901, name: 'identifier', value: 'fw01-operator-edit' },
    { id: 902, name: 'port', value: '1514' },
  ],
  enabled: true,
  description: 'Edge firewall syslog (operator wording)',
  credibility: 5,
}

const UPDATED = { name: 'Perimeter Firewall', existed: true, id: 42, prior: PRIOR_BODY }
const CREATED = { name: 'New Collector', existed: false, id: 77 }

test('log-sources rollback: re-posts exactly the body deploy captured', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${LS}/42`)
    assert.deepEqual(bodyOf(calls[0]), PRIOR_BODY, 'the operator gets back their own protocol parameters')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-sources rollback: deletes a log source the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${LS}/77`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('log-sources rollback: a source already gone is not an error', async () => {
  // 404 is a known answer: the object rollback would delete is already absent,
  // which is the state it was trying to reach.
  const { restore } = recordFetch([notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('log-sources rollback: an entry with no recorded id makes NO call', async () => {
  // Deploy records the id the console assigned. Without one there is no object
  // to address, and a rollback that guessed would delete or overwrite whatever
  // happens to sit at that path.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'Created But Unidentified', existed: false },
          { name: 'Updated But Unidentified', existed: true, prior: PRIOR_BODY },
        ],
      }),
    )

    assert.equal(calls.length, 0, 'an entry with no id must not be acted on')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('log-sources rollback: an entry with no recorded prior body makes NO call', async () => {
  // Posting an empty or invented body would blank the live log source's name,
  // parser and protocol parameters in one request.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Perimeter Firewall', existed: true, id: 42 }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('log-sources rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify log sources')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-sources rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${LS}/77`, `POST ${LS}/42`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
