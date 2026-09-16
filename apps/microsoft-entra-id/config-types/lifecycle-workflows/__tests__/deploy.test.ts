import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { buildCreateBody, buildPatchBody, resolveTaskDefinitionIds } from '../deploy'
import type { WorkflowSpec } from '../validate'

const ENABLE_ACCOUNT_ID = '6fc52c9d-398b-4305-9763-15f42c1676fc'
const nameToId = new Map([['enable user account', ENABLE_ACCOUNT_ID]])

describe('resolveTaskDefinitionIds — id-aware, backward compatible with hand-typed task names', () => {
  it('passes a GUID-shaped taskDefinitionId through unchanged, without consulting the map', () => {
    const { tasks, missing } = resolveTaskDefinitionIds([{ taskDefinitionId: ENABLE_ACCOUNT_ID, arguments: [] }], new Map())
    expect(tasks).toEqual([{ taskDefinitionId: ENABLE_ACCOUNT_ID, arguments: [] }])
    expect(missing).toEqual([])
  })

  it('resolves a hand-typed built-in task display name via the live task-definition map', () => {
    const { tasks, missing } = resolveTaskDefinitionIds([{ taskDefinitionId: 'Enable user account', arguments: [] }], nameToId)
    expect(tasks).toEqual([{ taskDefinitionId: ENABLE_ACCOUNT_ID, arguments: [] }])
    expect(missing).toEqual([])
  })

  it('reports an unresolvable task name as missing instead of silently passing it through', () => {
    const { missing } = resolveTaskDefinitionIds([{ taskDefinitionId: 'Ghost Task' }], nameToId)
    expect(missing).toEqual(['Ghost Task'])
  })

  it('leaves malformed or id-less entries untouched', () => {
    const tasks: unknown[] = [null, 'not-an-object', {}, { taskDefinitionId: 42 }]
    const { tasks: result, missing } = resolveTaskDefinitionIds(tasks, nameToId)
    expect(result).toEqual(tasks)
    expect(missing).toEqual([])
  })
})

describe('buildPatchBody / buildCreateBody', () => {
  const spec: WorkflowSpec = {
    itemId: 'item-1',
    name: 'Onboard',
    category: 'joiner',
    description: '',
    isEnabled: true,
    isSchedulingEnabled: false,
    executionConditions: '{"@odata.type":"#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions"}',
    tasks: '[]',
  }
  const resolvedTasks = [{ taskDefinitionId: ENABLE_ACCOUNT_ID, arguments: [] }]

  it('PATCH body carries the resolved tasks, never the immutable category', () => {
    const body = buildPatchBody(spec, resolvedTasks)
    expect(body.tasks).toEqual(resolvedTasks)
    expect(body.category).toBeUndefined()
  })

  it('POST body additionally includes the immutable category', () => {
    const body = buildCreateBody(spec, resolvedTasks)
    expect(body.category).toBe('joiner')
    expect(body.tasks).toEqual(resolvedTasks)
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported task resolver and body builders in
// isolation. What follows drives the DEFAULT export — the handler that writes
// the workflows that add and REMOVE a person's access automatically.
//
// `isEnabled` and `isSchedulingEnabled` are what separate a workflow that sits
// there from one that starts disabling accounts and stripping group membership
// on a schedule, so both are asserted on the wire. So is the resolved
// `taskDefinitionId`: a task that silently fails to resolve is a leaver
// workflow that runs and revokes nothing.
// ============================================================================

const WORKFLOW_BY_ID = /lifecycleWorkflows\/workflows\/[^/?]+$/
const WORKFLOW_CREATE = /lifecycleWorkflows\/workflows$/
const WORKFLOW_LIST = /lifecycleWorkflows\/workflows\?/
const TASK_DEFS = /lifecycleWorkflows\/taskDefinitions\?/

/** A real built-in task id from Microsoft's catalog (see ../lib/nameMaps.ts). */
const REMOVE_GROUPS_ID = '4bc7f740-180e-4586-adb6-38b2e9024e6b'

const EXECUTION_CONDITIONS = {
  '@odata.type': '#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions',
  scope: { '@odata.type': '#microsoft.graph.identityGovernance.ruleBasedSubjectSet', rule: "(department eq 'Sales')" },
  trigger: {
    '@odata.type': '#microsoft.graph.identityGovernance.timeBasedAttributeTrigger',
    timeBasedAttribute: 'employeeLeaveDateTime',
    offsetInDays: 0,
  },
}

const DECLARED_TASK = {
  taskDefinitionId: 'Remove user from all groups',
  displayName: 'Remove user from all groups',
  isEnabled: true,
  continueOnError: false,
  arguments: [],
}

/** The same task after the built-in catalog resolves its name to an id. */
const RESOLVED_TASK = { ...DECLARED_TASK, taskDefinitionId: REMOVE_GROUPS_ID }

function workflowItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Offboard leaver',
    {
      name: 'Offboard leaver',
      category: 'leaver',
      description: 'Revoke access on the last working day',
      isEnabled: true,
      isSchedulingEnabled: true,
      executionConditions: JSON.stringify(EXECUTION_CONDITIONS),
      tasks: JSON.stringify([DECLARED_TASK]),
      ...fields,
    },
    id,
  )
}

/** The live built-in task catalog the handler resolves task names against. */
function taskCatalog() {
  return collection([{ id: REMOVE_GROUPS_ID, displayName: 'Remove user from all groups' }])
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([workflowItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([workflowItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed workflow listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    {
      url: WORKFLOW_LIST,
      method: 'GET',
      respond: graphError(403, 'Insufficient privileges to complete the operation.'),
    },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await deploy(deployContext([workflowItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list lifecycle workflows/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live workflows must not create or patch any',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates the workflow with its category and resolved tasks', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([]) },
    { url: WORKFLOW_CREATE, method: 'POST', respond: created({ id: 'wf-new' }) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await deploy(deployContext([workflowItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the workflow')
    assert.ok(write.url.endsWith('/identityGovernance/lifecycleWorkflows/workflows'))

    assert.deepEqual(bodyOf(write), {
      category: 'leaver',
      displayName: 'Offboard leaver',
      description: 'Revoke access on the last working day',
      isEnabled: true,
      isSchedulingEnabled: true,
      executionConditions: EXECUTION_CONDITIONS,
      // The hand-typed task NAME has become the built-in catalog's id — a task
      // sent unresolved is a leaver workflow that revokes nothing.
      tasks: [RESOLVED_TASK],
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Offboard leaver', existed: false, id: 'wf-new' }])
    assert.equal(leaksSecret(result), false, 'the token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a workflow the canvas leaves disabled is never written enabled or scheduled', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([]) },
    { url: WORKFLOW_CREATE, method: 'POST', respond: created({ id: 'wf-new' }) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    await deploy(
      deployContext([workflowItem({ isEnabled: false, isSchedulingEnabled: false })]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.equal(body?.isEnabled, false)
    assert.equal(body?.isSchedulingEnabled, false)
  } finally {
    restore()
  }
})

test('an unknown task definition fails the item without writing a half-armed workflow', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([]) },
    { url: TASK_DEFS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([workflowItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown task definition\(s\) Remove user from all groups/)
    assert.match(String(result.message), /taskDefinitions/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a picker-stored task definition GUID is used verbatim, with no catalog lookup needed', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([]) },
    { url: WORKFLOW_CREATE, method: 'POST', respond: created({ id: 'wf-new' }) },
    // Empty catalog: a GUID must resolve without it, or the create never lands.
    { url: TASK_DEFS, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([workflowItem({ tasks: JSON.stringify([RESOLVED_TASK]) })]),
    )

    assert.equal(result.success, true)
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.tasks, [RESOLVED_TASK])
  } finally {
    restore()
  }
})

test('deploy updates a workflow that already exists and records its LIVE prior state', async () => {
  // The live workflow is disabled and does nothing. The deploy arms it — so the
  // recorded prior must be the DISABLED live state, or a rollback leaves a
  // leaver workflow running that the tenant never had.
  const live = {
    id: 'wf-1',
    category: 'leaver',
    displayName: 'Offboard leaver',
    description: 'Old description',
    isEnabled: false,
    isSchedulingEnabled: false,
    executionConditions: { '@odata.type': '#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions' },
    tasks: [],
  }
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([live]) },
    { url: WORKFLOW_BY_ID, method: 'PATCH', respond: ok({}) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await deploy(deployContext([workflowItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing workflow is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/lifecycleWorkflows/workflows/wf-1'))
    const sent = bodyOf(writes[0])
    // category is immutable in Graph — a PATCH carrying it is rejected outright.
    assert.equal(sent?.category, undefined)
    assert.equal(sent?.isEnabled, true)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'wf-1')
    assert.deepEqual(entries[0].prior, {
      displayName: 'Offboard leaver',
      description: 'Old description',
      isEnabled: false,
      isSchedulingEnabled: false,
      executionConditions: live.executionConditions,
      tasks: [],
    })
    assert.notDeepEqual(entries[0].prior, sent)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([]) },
    {
      url: WORKFLOW_CREATE,
      method: 'POST',
      respond: graphError(402, 'Tenant is not licensed for Microsoft Entra ID Governance.', 'NotLicensed'),
    },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await deploy(deployContext([workflowItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not licensed/i)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a workflow it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, method: 'GET', respond: collection([]) },
    { url: WORKFLOW_BY_ID, method: 'DELETE', respond: NO_CONTENT },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired workflow', existed: false, id: 'wf-old' },
            { name: 'Pre-existing workflow', existed: true, id: 'wf-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the workflow this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/lifecycleWorkflows/workflows/wf-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
