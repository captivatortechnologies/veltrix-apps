// deploy for ngsiem-lookup-files.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is that the CSV content IS the configuration: it travels
// inline through the JSON bulk surface (`lookup_files: [{ filename, content }]`
// under a `search_domain`), the file has no id — its filename within a
// search_domain is its identity — and the prior content has to be captured
// before it is overwritten or the enrichment table is unrecoverable.
//
// Read `../../../lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache and the 401 FalconClient silently retries. NOTE:
// unlike the RTR file types, this config type does NOT use
// `FalconClient.requestMultipart` — everything here is a JSON body.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  item,
  leaksSecret,
  notFound,
  ok,
  partialFailure,
  routeFetch,
  vendorCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const BULK = /\/ngsiem-content\/entities\/bulk-lookupfiles\/v1/

const CSV = 'hostname,owner,criticality\npay-db-01,payments,tier1\npay-db-02,payments,tier1'

/**
 * One declared lookup file. `extractLookupSpecs` reads a FLAT `fields` record
 * off each canvas item — `filename`, `repository` (the API `search_domain`),
 * `content`, `keyColumns`.
 */
const LOOKUP = item('Payment estate owners', {
  filename: 'payment-estate.csv',
  repository: 'all',
  content: CSV,
  keyColumns: 'hostname',
})

/**
 * The file as it exists in the tenant BEFORE this deploy — deliberately
 * different content, so a rollback record that captured the DESIRED CSV instead
 * of the LIVE one fails these assertions.
 */
const LIVE_LOOKUP = {
  filename: 'payment-estate.csv',
  search_domain: 'all',
  content: 'hostname,owner,criticality\nlegacy-db-01,unknown,tier3',
  modified_by: 'alice@acme.com',
}

registerDeployGuardContract({ label: 'ngsiem-lookup-files', handler: deploy, items: [LOOKUP] })

test('ngsiem-lookup-files deploy: creates a file that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: BULK, method: 'GET', respond: notFound() },
    { url: BULK, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.ok(body, 'the create carried no JSON body')
    assert.equal(body.search_domain, 'all')
    const files = body.lookup_files as Array<Record<string, unknown>>
    assert.equal(files.length, 1)
    assert.equal(files[0].filename, 'payment-estate.csv')
    assert.equal(files[0].content, CSV, 'CSV row/column layout is significant and goes verbatim')

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new file must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: records the created file so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: BULK, method: 'GET', respond: notFound() },
    { url: BULK, method: 'POST', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].filename, 'payment-estate.csv')
    assert.equal(state[0].existed, false)
    // A lookup file has no id — filename plus search_domain is its identity, so
    // rollback needs both to find what to delete.
    assert.equal(state[0].searchDomain, 'all')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: updates a file that already exists', async () => {
  const { calls, restore } = routeFetch([
    { url: BULK, method: 'GET', respond: entityPage([LIVE_LOOKUP]) },
    { url: BULK, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing file must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const files = bodyOf(patches[0])?.lookup_files as Array<Record<string, unknown>>
    assert.equal(files[0].filename, 'payment-estate.csv')
    assert.equal(files[0].content, CSV)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: records the LIVE prior CSV of a file it overwrote', async () => {
  // The canvas carries the new table; the tenant holds the old one. Rollback
  // restores what was there, so this must come from LIVE_LOOKUP.
  const { restore } = routeFetch([
    { url: BULK, method: 'GET', respond: entityPage([LIVE_LOOKUP]) },
    { url: BULK, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; prior?: { content?: string } }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(
      state[0].prior?.content,
      'hostname,owner,criticality\nlegacy-db-01,unknown,tier3',
      'an enrichment table overwritten without its prior content is unrecoverable',
    )
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: looks the file up within its declared search domain', async () => {
  const scoped = item('Parser lookup', {
    filename: 'parser-hints.csv',
    repository: 'parsers-repository',
    content: 'key,value\na,b',
  })
  const { calls, restore } = routeFetch([
    { url: BULK, method: 'GET', respond: notFound() },
    { url: BULK, method: 'POST', respond: ok() },
  ])
  try {
    await deploy(deployContext([scoped]))

    const gets = vendorCalls(calls).filter((c) => c.method === 'GET')
    assert.equal(gets.length, 1)
    assert.match(gets[0].url, /filename=parser-hints.csv/)
    assert.match(gets[0].url, /search_domain=parsers-repository/)
    assert.equal(bodyOf(callsOfMethod(calls, 'POST')[0])?.search_domain, 'parsers-repository')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: BULK, method: 'GET', respond: notFound() },
    { url: BULK, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an enrichment table it never wrote as deployed.
  const { restore } = routeFetch([
    { url: BULK, method: 'GET', respond: notFound() },
    { url: BULK, method: 'POST', respond: partialFailure('lookup file exceeds the size limit') },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /size limit/)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: does not treat an unreadable lookup as the file being absent', async () => {
  // A 500 on the bulk-get is "I could not look". Creating on that basis would
  // POST over a file that already exists.
  const { calls, restore } = routeFetch([{ url: BULK, method: 'GET', respond: { status: 500, body: {} } }])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    assert.equal(result.success, false)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'a failed read must not become "the file does not exist"',
    )
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: keeps the rollback record of what it wrote when a later file fails', async () => {
  const SECOND = item('Asset tiers', { filename: 'asset-tiers.csv', content: 'host,tier\na,1' })
  const { restore } = routeFetch([
    { url: BULK, method: 'GET', respond: notFound() },
    { url: BULK, method: 'POST', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 2, 'both files were recorded before being written')
    assert.equal(state[0].filename, 'payment-estate.csv')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: BULK, method: 'GET', respond: entityPage([LIVE_LOOKUP]) },
    { url: BULK, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([LOOKUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files deploy: skips a section with no CSV content', async () => {
  // Writing an empty table would silently drop every enrichment row.
  const NO_CONTENT = item('Placeholder', { filename: 'placeholder.csv', content: '   ' })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], EMPTY)
  try {
    const result = await deploy(deployContext([NO_CONTENT]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})
