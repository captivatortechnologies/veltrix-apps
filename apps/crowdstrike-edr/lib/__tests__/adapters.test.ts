import {
  findPolicyByName,
  policyAction,
  syncHostGroups,
  currentGroupIds,
  type PolicyEndpoints,
} from '../policyAdapter'
import {
  findExclusion,
  createExclusion,
  deleteExclusion,
  exclusionGroupIds,
  type ExclusionEndpoints,
} from '../exclusionAdapter'
import type { FalconClient } from '../falcon'

interface Call {
  method: string
  path: string
  opts?: { query?: Record<string, unknown>; body?: unknown }
}

function env(resources: unknown[], errors: unknown[] = []): string {
  return JSON.stringify({ meta: { trace_id: 't' }, resources, errors })
}

/** A FalconClient stub driven by a per-test handler; records every call. */
function mockClient(
  handler: (method: string, path: string, opts?: Call['opts']) => { status?: number; body: string },
): { client: FalconClient; calls: Call[] } {
  const calls: Call[] = []
  const client = {
    request: async (method: string, path: string, opts?: Call['opts']) => {
      calls.push({ method, path, opts })
      const r = handler(method, path, opts)
      const status = r.status ?? 200
      return { status, ok: status >= 200 && status < 300, body: r.body }
    },
  }
  return { client: client as unknown as FalconClient, calls }
}

const POLICY: PolicyEndpoints = {
  entity: '/policy/entities/sensor-update/v2',
  combined: '/policy/combined/sensor-update/v1',
  actions: '/policy/entities/sensor-update-actions/v2',
  perPlatform: true,
}

describe('policyAdapter', () => {
  it('finds a policy by exact name with a platform-scoped contains filter', async () => {
    const { client, calls } = mockClient(() =>
      ({ body: env([{ id: 'p1', name: 'Prod', platform_name: 'Windows' }]) }),
    )
    const found = await findPolicyByName(client, POLICY, 'Prod', 'Windows')
    expect(found?.id).toBe('p1')
    expect(String(calls[0].opts?.query?.filter)).toContain("platform_name:'Windows'")
    expect(String(calls[0].opts?.query?.filter)).toContain("name:~'Prod'")
  })

  it('ignores contains-filter noise and pins the exact name', async () => {
    const { client } = mockClient(() =>
      ({ body: env([{ id: 'a', name: 'Prod-2' }, { id: 'b', name: 'Prod' }]) }),
    )
    const found = await findPolicyByName(client, POLICY, 'Prod', 'Windows')
    expect(found?.id).toBe('b')
  })

  it('adopts a single unambiguous case-insensitive match, else null', async () => {
    const one = mockClient(() => ({ body: env([{ id: 'x', name: 'prod' }]) }))
    expect((await findPolicyByName(one.client, POLICY, 'Prod', 'Windows'))?.id).toBe('x')

    const many = mockClient(() =>
      ({ body: env([{ id: 'x', name: 'prod' }, { id: 'y', name: 'PROD' }]) }),
    )
    expect(await findPolicyByName(many.client, POLICY, 'Prod', 'Windows')).toBeNull()
  })

  it('issues enable/disable and host-group actions on the actions endpoint', async () => {
    const { client, calls } = mockClient(() => ({ body: env([{}]) }))
    await policyAction(client, POLICY, 'p1', 'enable')
    await policyAction(client, POLICY, 'p1', 'add-host-group', 'g1')
    expect(calls[0].path).toBe(POLICY.actions)
    expect(calls[0].opts?.query?.action_name).toBe('enable')
    expect(calls[1].opts?.body).toEqual({
      ids: ['p1'],
      action_parameters: [{ name: 'group_id', value: 'g1' }],
    })
  })

  it('converges host groups and records exact deltas for rollback', async () => {
    const { client, calls } = mockClient(() => ({ body: env([{}]) }))
    const record = { groupsAdded: [] as string[], groupsRemoved: [] as string[] }
    await syncHostGroups(client, POLICY, 'Prod', 'p1', ['g1', 'g2'], ['g2', 'g3'], record)
    expect(record.groupsAdded).toEqual(['g1'])
    expect(record.groupsRemoved).toEqual(['g3'])
    // one add + one remove action
    expect(calls.filter((c) => c.opts?.query?.action_name === 'add-host-group')).toHaveLength(1)
    expect(calls.filter((c) => c.opts?.query?.action_name === 'remove-host-group')).toHaveLength(1)
  })

  it('reads current group ids off a live policy', () => {
    expect(currentGroupIds({ groups: [{ id: 'a' }, { id: 'b' }, {}] })).toEqual(['a', 'b'])
  })

  it('throws a descriptive error when an action fails', async () => {
    const { client } = mockClient(() => ({ status: 403, body: env([], [{ message: 'denied' }]) }))
    let err: Error | null = null
    try {
      await policyAction(client, POLICY, 'p1', 'enable')
    } catch (e) {
      err = e as Error
    }
    expect(err?.message ?? '').toMatch(/denied/)
  })
})

const ML: ExclusionEndpoints = {
  entity: '/policy/entities/ml-exclusions/v1',
  queries: '/policy/queries/ml-exclusions/v1',
  identityField: 'value',
}

describe('exclusionAdapter', () => {
  it('finds an exclusion by querying ids then getting entities and pinning identity', async () => {
    const { client, calls } = mockClient((method, path) => {
      if (path.startsWith(ML.queries)) return { body: env(['id1', 'id2']) }
      // entity GET by ids
      return { body: env([{ id: 'id1', value: '/other' }, { id: 'id2', value: '/opt/app' }]) }
    })
    const found = await findExclusion(client, ML, '/opt/app')
    expect(found?.id).toBe('id2')
    expect(calls[0].path).toBe(ML.queries)
    expect(calls[1].path).toContain('ids=id1')
    expect(calls[1].path).toContain('ids=id2')
  })

  it('returns null when nothing matches the identity', async () => {
    const { client } = mockClient((_m, path) =>
      path.startsWith(ML.queries) ? { body: env([]) } : { body: env([]) },
    )
    expect(await findExclusion(client, ML, '/nope')).toBeNull()
  })

  it('creates an exclusion and returns the new id', async () => {
    const { client, calls } = mockClient(() => ({ status: 201, body: env([{ id: 'new1' }]) }))
    const id = await createExclusion(client, ML, { value: '/opt/app', applied_globally: true })
    expect(id).toBe('new1')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].opts?.body).toEqual({ value: '/opt/app', applied_globally: true })
  })

  it('deletes an exclusion with an ids+comment query', async () => {
    const { client, calls } = mockClient(() => ({ body: env([{}]) }))
    await deleteExclusion(client, ML, 'id9', 'removed by veltrix')
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].path).toContain('ids=id9')
    expect(calls[0].path).toContain('comment=removed')
  })

  it('extracts host-group ids whether groups are strings or objects', () => {
    expect(exclusionGroupIds({ groups: ['g1', { id: 'g2' }, {}] })).toEqual(['g1', 'g2'])
  })

  it('throws when create reports an envelope error on 2xx', async () => {
    const { client } = mockClient(() => ({ status: 200, body: env([], [{ message: 'bad value' }]) }))
    let err: Error | null = null
    try {
      await createExclusion(client, ML, { value: 'x' })
    } catch (e) {
      err = e as Error
    }
    expect(err?.message ?? '').toMatch(/bad value/)
  })
})
