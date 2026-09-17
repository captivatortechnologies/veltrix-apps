// deploy for rtr-put-files.
//
// A put-file is a file an RTR operator can stage onto any host in the tenant, so
// the BYTES this deploy uploads matter more than anything else it does. The
// create endpoint is multipart/form-data ONLY — `bodyOf()` returns null for
// those calls, and the content lives in the `file` part, which is why every
// assertion below reads the form rather than a JSON body.
//
// Put-files are also IMMUTABLE: there is no PATCH, so a content change is
// converged by delete-then-recreate, and GET never returns the stored bytes
// (only a sha256). Both shape the tests here.

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
  formField,
  formFileName,
  formFileText,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  vendorCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/real-time-response\/queries\/put-files\/v1/
const ENTITY = /\/real-time-response\/entities\/put-files\/v1/

/** Trailing newline included on purpose — put-file content is stored verbatim. */
const FILE_CONTENT = '# staged isolation payload\nStop-Service -Name RemoteRegistry\n'

/**
 * One declared put-file. `extractPutFileSpecs` reads a FLAT `fields` record —
 * `name`, `description`, `content`, `commentsForAuditLog`.
 */
const PUT_FILE = item('Isolation payload', {
  name: 'isolate-host.ps1',
  description: 'Staged isolation payload',
  content: FILE_CONTENT,
  commentsForAuditLog: 'Staged by the platform team',
})

/**
 * SHA-256 of a UTF-8 string, computed independently of the handler so a test
 * never agrees with `deploy.ts` simply by reusing its digest function.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

registerDeployGuardContract({ label: 'rtr-put-files', handler: deploy, items: [PUT_FILE] })

test('rtr-put-files deploy: uploads the declared bytes for a put-file that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    // Multipart: the JSON body is empty and fetch derives the Content-Type.
    assert.equal(bodyOf(posts[0]), null, 'the create is multipart, not JSON')
    assert.equal(posts[0].contentType, null, 'fetch must derive multipart/form-data + boundary')

    assert.equal(formField(posts[0], 'name'), 'isolate-host.ps1')
    assert.equal(formField(posts[0], 'description'), 'Staged isolation payload')
    assert.equal(formField(posts[0], 'comments_for_audit_log'), 'Staged by the platform team')
    assert.equal(formFileName(posts[0], 'file'), 'isolate-host.ps1')
    assert.equal(
      await formFileText(posts[0], 'file'),
      FILE_CONTENT,
      'the staged bytes must be exactly what the canvas declared',
    )

    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'nothing existed to delete')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: stamps its own audit comment when the canvas declared none', async () => {
  const noComment = item('Isolation payload', {
    name: 'isolate-host.ps1',
    description: 'Staged isolation payload',
    content: FILE_CONTENT,
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-1' }) },
  ])
  try {
    await deploy(deployContext([noComment]))

    assert.match(
      String(formField(callsOfMethod(calls, 'POST')[0], 'comments_for_audit_log')),
      /Managed by Veltrix/,
    )
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: records the created put-file so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'isolate-host.ps1')
    assert.equal(state[0].existed, false, 'a put-file this deploy created is not pre-existing')
    assert.equal(state[0].id, 'pf-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: leaves a put-file whose bytes already match completely untouched', async () => {
  // Put-files are immutable, so "converging" an identical file would mean
  // deleting a file RTR operators may be mid-way through using.
  const sha256 = await sha256Hex(FILE_CONTENT)
  const live = { id: 'pf-live-1', name: 'isolate-host.ps1', description: 'Staged isolation payload', sha256 }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pf-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an unchanged put-file must not be deleted')
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an unchanged put-file must not be re-uploaded')

    const state = (
      result.rollbackData as { previousState?: Array<{ existed: boolean; replaced?: boolean; id?: string }> }
    )?.previousState
    assert.equal(state?.[0].existed, true)
    assert.equal(state?.[0].replaced, false, 'rollback must know this file was left alone')
    assert.equal(state?.[0].id, 'pf-live-1')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: replaces a put-file whose bytes changed, deleting before it re-uploads', async () => {
  const live = {
    id: 'pf-live-1',
    name: 'isolate-host.ps1',
    description: 'legacy description nobody updated',
    sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pf-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-2' }) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, true)
    const sequence = vendorCalls(calls).map((c) => c.method)
    assert.deepEqual(
      sequence,
      ['GET', 'GET', 'DELETE', 'POST'],
      `expected lookup, delete, then re-upload, got ${describeCalls(vendorCalls(calls))}`,
    )
    assert.match(callsOfMethod(calls, 'DELETE')[0].url, /ids=pf-live-1/)
    assert.equal(
      await formFileText(callsOfMethod(calls, 'POST')[0], 'file'),
      FILE_CONTENT,
      'the replacement must carry the declared bytes',
    )
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: records the replacement and the description of the file it destroyed', async () => {
  const live = {
    id: 'pf-live-1',
    name: 'isolate-host.ps1',
    description: 'legacy description nobody updated',
    sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  }
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pf-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-2' }) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; replaced?: boolean; id?: string; priorDescription?: string }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].replaced, true)
    assert.equal(state[0].id, 'pf-new-2', 'rollback deletes the file this deploy uploaded, by its NEW id')
    assert.equal(
      state[0].priorDescription,
      'legacy description nobody updated',
      'the LIVE prior metadata, not the declared description',
    )
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: re-uploads when the API returned no sha256 to compare against', async () => {
  // A missing digest is "I could not verify", not "it matches" — skipping the
  // upload there would leave a stale payload staged for RTR operators.
  const live = { id: 'pf-live-1', name: 'isolate-host.ps1', description: 'Staged isolation payload' }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pf-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-2' }) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'an unverifiable file must be re-uploaded')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: reports failure rather than throwing when the upload is rejected', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a file it never staged as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('put-file quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: a failed re-upload after the delete is not reported as a success', async () => {
  // DEFECT (reported, not blessed): the converge path deletes the live put-file
  // BEFORE it uploads the replacement, and pushes the rollback entry only after
  // the upload succeeds. When the upload is rejected the customer's staged file
  // is gone AND nothing was recorded about it — and put-file bytes cannot be
  // read back from the API, so no later run can restore it either. Only the half
  // that is certainly right is asserted: the deploy does not claim success, and
  // the delete demonstrably happened. The absent rollback record is NOT asserted.
  const live = {
    id: 'pf-live-1',
    name: 'isolate-host.ps1',
    description: 'legacy description nobody updated',
    sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['pf-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([live]) },
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1, 'the original put-file was already destroyed')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: keeps the rollback record of what it wrote when a later put-file fails', async () => {
  // The first file is uploaded, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Collector', {
    name: 'collect.ps1',
    description: 'Artefact collector',
    content: 'Get-Process\n',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'pf-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /after 1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the put-file that WAS uploaded must still be recorded')
    assert.equal(state[0].id, 'pf-new-1')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'pf-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createPutFile` throws here AFTER the upload
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // file is staged in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([PUT_FILE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the file was in fact staged')
  } finally {
    restore()
  }
})

test('rtr-put-files deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
