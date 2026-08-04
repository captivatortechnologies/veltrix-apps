import { buildCreateBody, buildPatchBody, resolveTaskDefinitionIds } from '../deploy'
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
