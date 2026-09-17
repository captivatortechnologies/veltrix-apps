// deploy for ngsiem-parsers.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is that the parser SCRIPT is the whole configuration: it
// travels inline in a JSON body, the lookup is scoped by `repository` and
// `parser_type=custom`, and the canvas's `datatype`/`enabled` metadata is
// deliberately NOT written — the verified JSON endpoint does not model it.
//
// Read `../../../lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache and the 401 FalconClient silently retries. NOTE:
// unlike the RTR file types, this config type does NOT use
// `FalconClient.requestMultipart` — everything here is a JSON body.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CREATED_WITHOUT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  created,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  vendorCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/ngsiem-content\/queries\/parsers\/v1/
const ENTITY = /\/ngsiem-content\/entities\/parsers\/v1/

const SCRIPT = 'parseJson()\n| parseTimestamp(field=eventTime)\n| rename(src_ip, as=source.ip)'

/**
 * One declared parser. `extractParserSpecs` reads a FLAT `fields` record off
 * each canvas item — `name`, `repository`, `datatype`, `script`, `enabled`.
 */
const PARSER = item('Palo Alto traffic', {
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  datatype: 'paloalto:traffic',
  script: SCRIPT,
  enabled: true,
})

/**
 * The parser as it exists in the tenant BEFORE this deploy — deliberately
 * different script, so a rollback record that captured the DESIRED script
 * instead of the LIVE one fails these assertions.
 */
const LIVE_PARSER = {
  id: 'parser-live-1',
  name: 'paloalto-traffic',
  repository: 'parsers-repository',
  script: 'parseCsv()\n| rename(old_field, as=source.ip)',
  modified_by: 'alice@acme.com',
}

registerDeployGuardContract({ label: 'ngsiem-parsers', handler: deploy, items: [PARSER] })

test('ngsiem-parsers deploy: creates a parser that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'parser-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.ok(body, 'the create carried no JSON body')
    assert.equal(body.name, 'paloalto-traffic')
    assert.equal(body.repository, 'parsers-repository')
    assert.equal(body.script, SCRIPT, 'whitespace is significant in the parser DSL')
    // Canvas metadata the verified JSON endpoint does not model — sending it
    // would have the API reject an otherwise valid parser.
    assert.equal(body.datatype, undefined)
    assert.equal(body.enabled, undefined)

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new parser must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: scopes its lookup to the repository and custom parsers', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'parser-new-1' }) },
  ])
  try {
    await deploy(deployContext([PARSER]))

    const query = vendorCalls(calls).find((c) => QUERIES.test(c.url))
    assert.ok(query, 'deploy never searched for the existing parser')
    assert.match(query.url, /repository=parsers-repository/)
    assert.match(query.url, /parser_type=custom/, 'a CrowdStrike-shipped parser is not ours to overwrite')
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: records the created parser so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'parser-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'paloalto-traffic')
    assert.equal(state[0].existed, false)
    assert.equal(state[0].id, 'parser-new-1', 'without the new id rollback cannot delete what it created')
    assert.equal(state[0].repository, 'parsers-repository', 'a delete is scoped to the repository')
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: updates a parser that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['parser-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_PARSER]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing parser must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.ok(body, 'the update carried no JSON body')
    assert.equal(body.id, 'parser-live-1', 'the update must address the live parser by its id')
    assert.equal(body.name, 'paloalto-traffic')
    assert.equal(body.script, SCRIPT)
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: records the LIVE prior script of a parser it overwrote', async () => {
  // The canvas carries the new DSL; the tenant holds the old one. Rollback
  // restores what was there, so this must come from LIVE_PARSER.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['parser-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_PARSER]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: { script?: string } }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'parser-live-1')
    assert.equal(
      state[0].prior?.script,
      'parseCsv()\n| rename(old_field, as=source.ip)',
      'a parser overwritten without its prior script is unrecoverable',
    )
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a parser it never created as deployed — and every
  // event that parser was to normalize arrives unparsed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('parser script failed to compile') },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /failed to compile/)
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: does not treat an unreadable search as the parser being absent', async () => {
  // A 500 on the id query is "I could not look". Creating on that basis would
  // POST a duplicate over a parser that already exists.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: { status: 500, body: {} } }])
  try {
    const result = await deploy(deployContext([PARSER]))

    assert.equal(result.success, false)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'a failed read must not become "the parser does not exist"',
    )
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: keeps the rollback record of what it wrote when a later parser fails', async () => {
  const SECOND = item('Zscaler web', { name: 'zscaler-web', script: 'parseJson()' })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'parser-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([PARSER, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the parser that WAS created must still be recorded')
    assert.equal(state[0].id, 'parser-new-1')
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['parser-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_PARSER]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createParser` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // parser now exists in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([PARSER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no parser id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the parser was in fact created')
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('ngsiem-parsers deploy: skips a section with no parser script', async () => {
  // Writing an empty script would leave every event this parser normalizes raw.
  const NO_SCRIPT = item('Placeholder', { name: 'placeholder', script: '  ' })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], EMPTY)
  try {
    const result = await deploy(deployContext([NO_SCRIPT]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})
