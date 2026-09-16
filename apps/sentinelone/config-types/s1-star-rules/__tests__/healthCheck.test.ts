import healthCheck from '../healthCheck'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-star-rules'
const S1QL = 'EventType = "Process Creation"'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const powershell: CanvasItemInput = {
  name: 'Rule 1',
  fields: { name: 'Suspicious PowerShell', s1ql: S1QL },
}
const lateral: CanvasItemInput = {
  name: 'Rule 2',
  fields: { name: 'Lateral movement', s1ql: S1QL },
}

describe('SentinelOne STAR Rules Health Check Handler', () => {
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
      const result = await healthCheck(ctx([powershell], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared rule is present at the scope', async () => {
    await withFetch(
      [envelope([{ id: 'r-1', name: 'Suspicious PowerShell' }, { id: 'r-2', name: 'Lateral movement' }])],
      async () => {
        const result = await healthCheck(ctx([powershell, lateral]))
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('matches a live rule whose name differs only by case', async () => {
    await withFetch([envelope([{ id: 'r-1', name: 'suspicious powershell' }])], async () => {
      const result = await healthCheck(ctx([powershell]))
      expect(result.healthy).toBe(true)
    })
  })

  it('reports the specific rule that has gone missing', async () => {
    await withFetch([envelope([{ id: 'r-1', name: 'Suspicious PowerShell' }])], async () => {
      const result = await healthCheck(ctx([powershell, lateral]))

      expect(result.healthy).toBe(false)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toBe('rule:Lateral movement')
    })
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([powershell]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
