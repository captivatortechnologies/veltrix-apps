import healthCheck from '../healthCheck'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-exclusions'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const appDir: CanvasItemInput = {
  name: 'Exclusion 1',
  fields: { type: 'path', value: '/opt/app', os_type: 'linux' },
}
const varLog: CanvasItemInput = {
  name: 'Exclusion 2',
  fields: { type: 'path', value: '/var/log', os_type: 'linux' },
}

describe('SentinelOne Exclusions Health Check Handler', () => {
  it('fails closed without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([appDir], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(result.score).toBe(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared exclusion is present at the scope', async () => {
    await withFetch(
      [
        envelope([
          { id: 'exc-1', type: 'path', value: '/opt/app', osType: 'linux' },
          { id: 'exc-2', type: 'path', value: '/var/log', osType: 'linux' },
        ]),
      ],
      async () => {
        const result = await healthCheck(ctx([appDir, varLog]))
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('reports the specific exclusion that has gone missing', async () => {
    await withFetch(
      [envelope([{ id: 'exc-1', type: 'path', value: '/opt/app', osType: 'linux' }])],
      async () => {
        const result = await healthCheck(ctx([appDir, varLog]))

        expect(result.healthy).toBe(false)
        const failed = result.checks.filter((check) => !check.passed)
        expect(failed).toHaveLength(1)
        expect(failed[0].name).toContain('/var/log')
      },
    )
  })

  it('does not match an exclusion whose OS differs', async () => {
    await withFetch(
      [envelope([{ id: 'exc-1', type: 'path', value: '/opt/app', osType: 'macos' }])],
      async () => {
        const result = await healthCheck(ctx([appDir]))
        expect(result.healthy).toBe(false)
        expect(result.score).toBe(50)
      },
    )
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([appDir]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
      expect(result.checks[0].message).toMatch(/service unavailable/)
    })
  })
})
