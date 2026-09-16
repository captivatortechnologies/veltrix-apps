import healthCheck from '../healthCheck'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-rbac-roles'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const analyst: CanvasItemInput = { name: 'Role 1', fields: { name: 'SOC Analyst' } }
const auditor: CanvasItemInput = { name: 'Role 2', fields: { name: 'Auditor' } }

describe('SentinelOne RBAC Roles Health Check Handler', () => {
  it('fails closed without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('s1_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([analyst], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared role is present at the scope', async () => {
    await withFetch(
      [envelope([{ id: 'role-1', name: 'SOC Analyst' }, { id: 'role-2', name: 'Auditor' }])],
      async () => {
        const result = await healthCheck(ctx([analyst, auditor]))
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('reports the specific role that has been deleted', async () => {
    await withFetch([envelope([{ id: 'role-1', name: 'SOC Analyst' }])], async () => {
      const result = await healthCheck(ctx([analyst, auditor]))

      expect(result.healthy).toBe(false)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toBe('role:Auditor')
    })
  })

  it('matches a live role whose name differs only by case', async () => {
    await withFetch([envelope([{ id: 'role-1', name: 'soc analyst' }])], async () => {
      const result = await healthCheck(ctx([analyst]))
      expect(result.healthy).toBe(true)
    })
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([analyst]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
