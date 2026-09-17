// rollback for ngsiem-lookup-files.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that a lookup file has no id — a created file is deleted by
// filename within its search_domain, through the PER-FILE collection rather than
// the bulk one — and that an entry whose prior CSV was never captured must be
// left alone and FLAGGED rather than overwritten with a guess.

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

const BULK = /\/ngsiem-content\/entities\/bulk-lookupfiles\/v1/
const PER_FILE = /\/ngsiem-content\/entities\/lookupfiles\/v1/

const PRIOR_CSV = 'hostname,owner,criticality\nlegacy-db-01,unknown,tier3'

const CREATED_ENTRY = { filename: 'payment-estate.csv', searchDomain: 'all', existed: false }

const UPDATED_ENTRY = {
  filename: 'payment-estate.csv',
  searchDomain: 'all',
  existed: true,
  prior: { content: PRIOR_CSV },
}

registerRollbackGuardContract({
  label: 'ngsiem-lookup-files',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('ngsiem-lookup-files rollback: deletes a created file through the per-file collection', async () => {
  const { calls, restore } = routeFetch([{ url: PER_FILE, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /filename=payment-estate.csv/)
    assert.match(deletes[0].url, /search_domain=all/, 'the file is only identified within its domain')
    // The bulk surface has no DELETE — routing it there would leave the file.
    assert.equal(
      /bulk-lookupfiles/.test(deletes[0].url),
      false,
      `delete went to the bulk collection: ${deletes[0].url}`,
    )
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created file is deleted, not patched')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files rollback: treats an already-deleted file as done rather than failing', async () => {
  const { restore } = routeFetch([{ url: PER_FILE, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '404 on a delete is the desired end state, not an error')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files rollback: restores the recorded prior CSV of a file it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: BULK, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.ok(body, 'the restore carried no JSON body')
    assert.equal(body.search_domain, 'all')
    const files = body.lookup_files as Array<Record<string, unknown>>
    assert.equal(files[0].filename, 'payment-estate.csv')
    assert.equal(files[0].content, PRIOR_CSV)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated file must never be deleted')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files rollback: leaves a file alone and flags it when the prior CSV was never captured', async () => {
  // Writing an invented table over a live enrichment file is worse than leaving
  // the deployed one in place — but the operator has to be told.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({
        previousState: [{ filename: 'payment-estate.csv', searchDomain: 'all', existed: true }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
    assert.match(String(result.message), /prior CSV content was unavailable/)
    assert.match(String(result.message), /payment-estate.csv/)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: PER_FILE, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('ngsiem-lookup-files rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: BULK, method: 'PATCH', respond: partialFailure('lookup file is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored file')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: BULK, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, filename: 'asset-tiers.csv' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
