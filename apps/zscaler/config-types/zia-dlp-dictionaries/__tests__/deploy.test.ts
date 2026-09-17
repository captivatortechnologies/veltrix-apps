// deploy for zia-dlp-dictionaries.
//
// What is specific to this type and worth driving end to end:
//   * identity is `name` and the id is NUMERIC;
//   * the canvas carries phrases and patterns as multi-line textareas, which the
//     payload has to expand into ZIA's entry shape
//     ({ action: 'PHRASE_COUNT_TYPE_ALL', phrase }) — the one real translation
//     this handler performs;
//   * a PREDEFINED dictionary (`custom: false`) must never be overwritten;
//   * the update path must record the LIVE prior phrases and patterns, which are
//     the only thing rollback can restore;
//   * ZIA stages writes, so a deploy that never reaches `/status/activate` has
//     changed nothing the customer can see.
//
// NOT asserted, deliberately: the path where the POST succeeds but the response
// carries no id. deploy throws there BEFORE pushing the rollback entry, so the
// dictionary exists in the tenant with nothing recorded — see the report.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const DICTIONARY = item('Acme Secrets', {
  name: 'Acme Secrets',
  description: 'desired description',
  dictionary_type: 'PATTERNS_AND_PHRASES',
  phrases: 'project-zephyr\nacme-confidential',
  patterns: 'ACME-[0-9]{6}',
  custom_phrase_match_type: 'MATCH_ANY_CUSTOM_PHRASE_PATTERN_DICTIONARY',
})

/**
 * The live dictionary, deliberately UNLIKE the canvas: a different description,
 * one stale phrase, no patterns and the other match type. A rollback entry
 * mirroring the canvas rather than this has recorded the desired state, not the
 * prior state.
 */
const LIVE = {
  id: 7701,
  name: 'Acme Secrets',
  custom: true,
  description: 'live description set by hand',
  dictionaryType: 'PATTERNS_AND_PHRASES',
  phrases: [{ action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'legacy-phrase' }],
  patterns: [],
  customPhraseMatchType: 'MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY',
}

const OTHER = { id: 7799, name: 'Something Else', custom: true }

registerDeployGuardContract({
  label: 'zia-dlp-dictionaries',
  handler: deploy,
  product: 'zia',
  items: [DICTIONARY],
})

test('zia-dlp-dictionaries deploy: creates a dictionary that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER]),
    created({ id: 7710, name: 'Acme Secrets' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([DICTIONARY]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpDictionaries\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/dlpDictionaries$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Acme Secrets')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.dictionaryType, 'PATTERNS_AND_PHRASES')
    assert.equal(body?.customPhraseMatchType, 'MATCH_ANY_CUSTOM_PHRASE_PATTERN_DICTIONARY')
    assert.equal(body?.custom, true)
    assert.deepEqual(body?.phrases, [
      { action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'project-zephyr' },
      { action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'acme-confidential' },
    ])
    assert.deepEqual(body?.patterns, [{ action: 'PATTERN_COUNT_TYPE_ALL', pattern: 'ACME-[0-9]{6}' }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Acme Secrets', existed: false, id: 7710 }])
    assert.deepEqual(rollback.createdIds, [7710])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries deploy: updates an existing dictionary and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 7701 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([DICTIONARY]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a dictionary that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/dlpDictionaries\/7701$/)
    assert.equal(bodyOf(tenant[1])?.description, 'desired description')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 7701)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.deepEqual(entry.prior.phrases, [{ action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'legacy-phrase' }])
    assert.deepEqual(entry.prior.patterns, [])
    assert.equal(entry.prior.customPhraseMatchType, 'MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries deploy: refuses to overwrite a predefined dictionary, and writes nothing', async () => {
  const predefined = { id: 12, name: 'Acme Secrets', custom: false }
  const { calls, restore } = recordFetch([TOKEN, ziaList([predefined])])
  try {
    const result = await deploy(deployContext([DICTIONARY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined DLP dictionary/)
    assert.equal(writeCalls(calls).length, 0, 'a built-in dictionary must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'a predefined dictionary is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Invalid regular expression in pattern'),
  ])
  try {
    const result = await deploy(deployContext([DICTIONARY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Invalid regular expression in pattern/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live dictionary, so the prior body deploy
    // read beforehand has to survive on the failure path or it can never be
    // restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { description?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.description, 'live description set by hand')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/dlpDictionaries/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([DICTIONARY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list DLP dictionaries/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER]),
    created({ id: 7710 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([DICTIONARY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [7710], 'the staged dictionary still exists and must be revertible')
  } finally {
    restore()
  }
})
