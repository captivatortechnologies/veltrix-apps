import driftDetect from '../driftDetect'
import {
  SCOPELESS_SETTINGS,
  SERVICE_USER,
  apiError,
  callsTo,
  driftContext,
  envelope,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-rbac-roles'
const ROLE_DETAIL = '/rbac/role/role-1'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const analyst: CanvasItemInput = {
  name: 'Role 1',
  fields: { name: 'SOC Analyst', permissions: { 'threats.mitigate': 'true' } },
}

const roleList = envelope([{ id: 'role-1', name: 'SOC Analyst' }])

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne RBAC Roles Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [analyst], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([analyst], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a role deleted at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async (calls) => {
      const result = await driftDetect(ctx([analyst]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('SOC Analyst')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
      // A role that is gone has no detail to read.
      expect(callsTo(calls, ROLE_DETAIL)).toHaveLength(0)
    })
  })

  it('reports a revoked permission as warning-level drift', async () => {
    const detail = envelope({ permissions: { threats: { mitigate: false } } })
    await withFetch([roleList, detail, envelope([])], async (calls) => {
      const result = await driftDetect(ctx([analyst]))

      expect(callsTo(calls, ROLE_DETAIL)).toHaveLength(1)
      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('SOC Analyst.threats.mitigate')
      expect(result.diffs[0].expected).toBe('true')
      expect(result.diffs[0].actual).toBe('false')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('reports a permission the role no longer carries as "not set"', async () => {
    await withFetch([roleList, envelope({ permissions: {} }), envelope([])], async () => {
      const result = await driftDetect(ctx([analyst]))

      expect(result.diffs[0].actual).toBe('not set')
    })
  })

  it('reads an un-wrapped permission tree with the same rule as deploy', async () => {
    await withFetch([roleList, envelope({ threats: { mitigate: true } })], async () => {
      const result = await driftDetect(ctx([analyst]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('does not read the role detail when no permission overrides are declared', async () => {
    await withFetch([roleList], async (calls) => {
      const result = await driftDetect(ctx([{ name: 'Role 1', fields: { name: 'SOC Analyst' } }]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, ROLE_DETAIL)).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([analyst]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports an unreadable role detail as critical drift rather than throwing', async () => {
    await withFetch([roleList, apiError('detail unavailable', 500)], async () => {
      const result = await driftDetect(ctx([analyst]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].actual).toMatch(/unreachable/)
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Role 'SOC Analyst' was updated by Alice Admin.",
      userId: 'u-alice',
      data: { username: 'Alice Admin', roleName: 'SOC Analyst' },
    }
    await withFetch(
      [roleList, envelope({ permissions: { threats: { mitigate: false } } }), envelope([activity])],
      async () => {
        const result = await driftDetect(ctx([analyst]))
        expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
      },
    )
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Role 'SOC Analyst' was updated by veltrix-svc.",
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, roleName: 'SOC Analyst' },
    }
    await withFetch(
      [roleList, envelope({ permissions: { threats: { mitigate: false } } }), envelope([ourOwnDeploy])],
      async () => {
        const result = await driftDetect(ctx([analyst]))

        expect(result.hasDrift).toBe(true)
        expect(actorOf(result.diffs[0])).toBeUndefined()
      },
    )
  })
})
