// rollback for ngsiem-parsers.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that both branches act on the RECORDED id scoped to its
// repository — there is no re-resolution by name — so an entry with no id, or
// no captured script, must produce no write at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  forbidden,
  leaksSecret,
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/ngsiem-content\/entities\/parsers\/v1/

const PRIOR_SCRIPT = 'parseCsv()\n| rename(old_field, as=source.ip)'

const CREATED_ENTRY = {
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  existed: false,
  id: 'parser-new-1',
}

const UPDATED_ENTRY = {
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  existed: true,
  id: 'parser-live-1',
  prior: { script: PRIOR_SCRIPT },
}

registerRollbackGuardContract({
  label: 'ngsiem-parsers',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('ngsiem-parsers rollback: deletes a parser this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=parser-new-1/)
    assert.match(deletes[0].url, /repository=parsers-repository/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created parser is deleted, not patched')
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: treats an already-deleted parser as done rather than failing', async () => {
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '404 on a delete is the desired end state, not an error')
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({
        previousState: [{ name: 'paloalto-traffic', repository: 'parsers-repository', existed: false }],
      }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: restores the recorded prior script of a parser it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.ok(body, 'the restore carried no JSON body')
    assert.equal(body.id, 'parser-live-1')
    assert.equal(body.name, 'paloalto-traffic')
    assert.equal(body.repository, 'parsers-repository')
    assert.equal(body.script, PRIOR_SCRIPT)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated parser must never be deleted')
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: writes nothing for an updated entry whose prior script was never captured', async () => {
  // Deploy overwrote a live parser but recorded no prior script. Writing an
  // invented one would leave every event it normalizes mis-parsed.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'paloalto-traffic', repository: 'parsers-repository', existed: true, id: 'parser-live-1' },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'paloalto-traffic',
            repository: 'parsers-repository',
            existed: true,
            prior: { script: PRIOR_SCRIPT },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('parser is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored parser')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('ngsiem-parsers rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'zscaler-web', id: 'parser-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
