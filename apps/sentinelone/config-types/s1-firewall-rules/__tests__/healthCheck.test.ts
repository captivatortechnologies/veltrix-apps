import healthCheck from '../healthCheck'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-firewall-rules'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const blockRdp: CanvasItemInput = {
  name: 'Rule 1',
  fields: { name: 'Block inbound RDP', action: 'Blocked', direction: 'inbound', service: '3389' },
}
const blockSmb: CanvasItemInput = {
  name: 'Rule 2',
  fields: { name: 'Block inbound SMB', action: 'Blocked', direction: 'inbound', service: '445' },
}

describe('SentinelOne Firewall Rules Health Check Handler', () => {
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
      const result = await healthCheck(ctx([blockRdp], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared rule is present at the scope', async () => {
    await withFetch(
      [envelope([{ id: 'fw-1', name: 'Block inbound RDP' }, { id: 'fw-2', name: 'Block inbound SMB' }])],
      async () => {
        const result = await healthCheck(ctx([blockRdp, blockSmb]))
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('reports the specific rule that has gone missing', async () => {
    await withFetch([envelope([{ id: 'fw-1', name: 'Block inbound RDP' }])], async () => {
      const result = await healthCheck(ctx([blockRdp, blockSmb]))

      expect(result.healthy).toBe(false)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toBe('rule:Block inbound SMB')
    })
  })

  it('matches a live rule whose name differs only by case', async () => {
    await withFetch([envelope([{ id: 'fw-1', name: 'block INBOUND rdp' }])], async () => {
      const result = await healthCheck(ctx([blockRdp]))
      expect(result.healthy).toBe(true)
    })
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([blockRdp]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
