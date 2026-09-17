// ============================================================================
// driftDetect for Entra lifecycle workflows, against a fake Microsoft Graph.
//
// A lifecycle workflow acts on people's accounts on a schedule, so the drift
// that matters is a workflow switched off (offboarding silently stops running)
// or its task list rewritten (it runs and revokes the wrong things). The
// handler also has a CRITICAL branch for a task name that no longer resolves
// against the built-in catalog, so an unresolvable task never reads as "no
// drift".
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const WORKFLOW_LIST = /lifecycleWorkflows\/workflows\?/
const TASK_DEFS = /lifecycleWorkflows\/taskDefinitions\?/

const REMOVE_GROUPS_ID = '4bc7f740-180e-4586-adb6-38b2e9024e6b'

const EXECUTION_CONDITIONS = {
  '@odata.type': '#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions',
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
  arguments: [],
}

const RESOLVED_TASK = { ...DECLARED_TASK, taskDefinitionId: REMOVE_GROUPS_ID }

function taskCatalog() {
  return collection([{ id: REMOVE_GROUPS_ID, displayName: 'Remove user from all groups' }])
}

function liveWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    category: 'leaver',
    displayName: 'Offboard leaver',
    description: 'Revoke access on the last working day',
    isEnabled: true,
    isSchedulingEnabled: true,
    executionConditions: EXECUTION_CONDITIONS,
    tasks: [RESOLVED_TASK],
    ...over,
  }
}

function workflowItem(fields: Record<string, unknown> = {}) {
  return item('Offboard leaver', {
    name: 'Offboard leaver',
    category: 'leaver',
    description: 'Revoke access on the last working day',
    isEnabled: true,
    isSchedulingEnabled: true,
    executionConditions: JSON.stringify(EXECUTION_CONDITIONS),
    tasks: JSON.stringify([DECLARED_TASK]),
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([workflowItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([workflowItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live workflow matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([liveWorkflow()]) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted workflow is critical present/absent drift', async () => {
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([]) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Offboard leaver', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a workflow switched off in the portal surfaces field by field', async () => {
  const { restore } = routeFetch([
    {
      url: WORKFLOW_LIST,
      respond: collection([liveWorkflow({ isEnabled: false, isSchedulingEnabled: false })]),
    },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Offboard leaver.isEnabled', expected: 'true', actual: 'false', severity: 'warning' },
      { field: 'Offboard leaver.isSchedulingEnabled', expected: 'true', actual: 'false', severity: 'warning' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a task list rewritten in the portal surfaces with both sides intact', async () => {
  const drifted = [{ ...RESOLVED_TASK, isEnabled: false }]
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([liveWorkflow({ tasks: drifted })]) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    assert.equal(result.diffs.length, 1)
    const diff = result.diffs[0]
    assert.equal(diff.field, 'Offboard leaver.tasks')
    assert.equal(diff.severity, 'warning')
    // Both sides are canonicalised JSON — parse them back so the assertion is
    // about the structure rather than a key ordering.
    assert.deepEqual(JSON.parse(String(diff.expected)), [RESOLVED_TASK])
    assert.deepEqual(JSON.parse(String(diff.actual)), drifted)
  } finally {
    restore()
  }
})

test('execution conditions retargeted in the portal surface as their own diff', async () => {
  const drifted = { ...EXECUTION_CONDITIONS, trigger: { '@odata.type': '#microsoft.graph.identityGovernance.attributeChangeTrigger' } }
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([liveWorkflow({ executionConditions: drifted })]) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    const diff = result.diffs.find((d) => d.field === 'Offboard leaver.executionConditions')
    assert.ok(diff)
    assert.equal(diff.severity, 'warning')
    assert.deepEqual(JSON.parse(String(diff.expected)), EXECUTION_CONDITIONS)
    assert.deepEqual(JSON.parse(String(diff.actual)), drifted)
  } finally {
    restore()
  }
})

test('a description edited in the portal surfaces as its own diff', async () => {
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([liveWorkflow({ description: 'Edited in the portal' })]) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Offboard leaver.description',
        expected: 'Revoke access on the last working day',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a task name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([liveWorkflow()]) },
    { url: TASK_DEFS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([workflowItem()]))

    const diff = result.diffs.find((d) => d.field === 'Offboard leaver.tasks')
    assert.ok(diff)
    assert.equal(diff.expected, 'resolvable')
    assert.equal(diff.severity, 'critical')
    assert.match(String(diff.actual), /Remove user from all groups/)
  } finally {
    restore()
  }
})

test('drift is measured against the DEPLOYED canvas, not the edited one', async () => {
  // The canvas has since been edited to disable the workflow, but nothing has
  // deployed that — the live workflow still matches what was last deployed.
  const { restore } = routeFetch([
    { url: WORKFLOW_LIST, respond: collection([liveWorkflow()]) },
    { url: TASK_DEFS, respond: taskCatalog() },
  ])
  try {
    const result = await driftDetect(
      driftContext([workflowItem({ isEnabled: false })], { deployedItems: [workflowItem()] }),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
