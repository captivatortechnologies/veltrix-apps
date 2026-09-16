import healthCheck from '../healthCheck'
import { GROUPS_REQUIRE_SITE_SCOPE } from '../validate'
import {
  ACCOUNT_SETTINGS,
  SITE_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-groups'

function ctx(sections: CanvasItemInput[], settings: Record<string, unknown> = SITE_SETTINGS) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const servers: CanvasItemInput = { name: 'Group 1', fields: { name: 'Servers' } }
const workstations: CanvasItemInput = { name: 'Group 2', fields: { name: 'Workstations' } }

describe('SentinelOne Groups Health Check Handler', () => {
  it('fails closed without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ configTypeId: CONFIG_TYPE, settings: SITE_SETTINGS, credential: null }),
      )
      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed at a non-site scope', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([servers], ACCOUNT_SETTINGS))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('s1_site_scope')
      expect(result.checks[0].message).toBe(GROUPS_REQUIRE_SITE_SCOPE)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([servers], { scope: 'site', scope_id: '' }))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared group is present at the site', async () => {
    await withFetch(
      [envelope([{ id: 'grp-1', name: 'Servers' }, { id: 'grp-2', name: 'Workstations' }])],
      async () => {
        const result = await healthCheck(ctx([servers, workstations]))

        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('reports the specific group that has gone missing', async () => {
    await withFetch([envelope([{ id: 'grp-1', name: 'Servers' }])], async () => {
      const result = await healthCheck(ctx([servers, workstations]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      const missing = result.checks.filter((check) => !check.passed)
      expect(missing).toHaveLength(1)
      expect(missing[0].name).toBe('group:Workstations')
      expect(missing[0].message).toContain('missing')
    })
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([servers]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('s1_reachable')
      expect(result.checks[0].message).toMatch(/service unavailable/)
    })
  })
})
