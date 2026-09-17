// rollback for zia-dlp-dictionaries.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body
// replays the prior phrase and pattern ENTRIES verbatim rather than rebuilding
// them from a canvas; a dictionary deploy created is DELETEd; a dictionary
// already gone (404) is not an error; and the revert is itself a staged ZIA
// change, so it only takes effect on activation.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACTIVATED,
  NO_CONTENT,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-dlp-dictionaries',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Acme Secrets',
  existed: true,
  id: 7701,
  prior: {
    name: 'Acme Secrets',
    description: 'live description set by hand',
    dictionaryType: 'PATTERNS_AND_PHRASES',
    phrases: [{ action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'legacy-phrase' }],
    patterns: [],
    customPhraseMatchType: 'MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY',
  },
}

const CREATED_ENTRY = { name: 'New Dictionary', existed: false, id: 7710 }

test('zia-dlp-dictionaries rollback: restores the prior body of a dictionary deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 7701 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpDictionaries\/7701$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.description, 'live description set by hand')
    assert.deepEqual(body?.phrases, [{ action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'legacy-phrase' }])
    assert.deepEqual(body?.patterns, [])
    assert.equal(body?.customPhraseMatchType, 'MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY')
    assert.equal(body?.custom, true)

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries rollback: deletes a dictionary deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpDictionaries\/7710$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries rollback: a dictionary already gone is not an error', async () => {
  // 404 is a known answer — the dictionary we would delete is already absent,
  // which is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Dictionary is in use by a DLP engine')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Dictionary is in use by a DLP engine/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries rollback: a failed activation is reported as still-staged', async () => {
  const { restore } = recordFetch([TOKEN, ok({}), ziaError(409, 'Another activation is already in progress')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /Re-run rollback/)
  } finally {
    restore()
  }
})
