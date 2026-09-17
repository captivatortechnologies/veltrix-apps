// deploy for ISC workflows.
//
// ISC will not create an enabled workflow, so deploy POSTs it disabled and enables
// it with a follow-up PATCH. The update is a whole-body PUT, which is what makes
// the prior snapshot — trigger and definition included — the only way back.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOKEN,
  bodyOf,
  created,
  deployContext,
  iscError,
  listPage,
  ok,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveWorkflow, workflowItem } from './fixtures'

registerCollectionDeployContract({
  label: 'workflows',
  handler: deploy,
  listPath: '/v3/workflows',
  createPath: '/v3/workflows',
  updatePath: '/v3/workflows/wf-77b3aa',
  updateMethod: 'PUT',
  item: workflowItem(),
  live: liveWorkflow(),
  createBodyIncludes: ['Joiner Notification', 'idn:identity-created', '"enabled":false'],
  updateBodyIncludes: ['Emails the manager when a joiner is created', 'id-owner-current'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Workflow', existed: false, id: 'wf-retired' },
    deletePath: '/v3/workflows/wf-retired',
  },
})

test('workflows deploy: creates disabled, then enables in a second call', async () => {
  // ISC rejects a create that arrives enabled. A handler that sent enabled=true
  // on the POST would fail for every workflow the canvas wants running.
  const { calls, restore } = recordFetch([TOKEN, listPage([]), created({ id: 'wf-new' }), ok({})])
  try {
    const result = await deploy(deployContext([workflowItem({ enabled: true })]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].method, 'POST')
    assert.equal((bodyOf(writes[0]) as Record<string, unknown>).enabled, false)
    assert.equal(writes[1].method, 'PATCH')
    assert.equal(pathOf(writes[1]), '/v3/workflows/wf-new')
    assert.deepEqual(bodyOf(writes[1]), [{ op: 'replace', path: '/enabled', value: true }])
  } finally {
    restore()
  }
})

test('workflows deploy: still records the created workflow when enabling it fails', async () => {
  // The workflow exists after the POST. If the enable fails and nothing is
  // recorded, rollback cannot remove the workflow the deploy just created.
  const { restore } = recordFetch([TOKEN, listPage([]), created({ id: 'wf-new' }), iscError(403, 'not permitted')])
  try {
    const result = await deploy(deployContext([workflowItem({ enabled: true })]))

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries?: Array<Record<string, unknown>> }).entries ?? []
    assert.equal(entries.length, 1, 'the created workflow must still be recoverable')
    assert.equal(entries[0].id, 'wf-new')
    assert.equal(entries[0].existed, false)
  } finally {
    restore()
  }
})
