import healthCheck from '../healthCheck'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-device-control'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const blockUsb: CanvasItemInput = {
  name: 'Rule 1',
  fields: { rule_name: 'Block mass storage', interface: 'USB', action: 'Block' },
}
const blockBt: CanvasItemInput = {
  name: 'Rule 2',
  fields: { rule_name: 'Block Bluetooth', interface: 'Bluetooth', action: 'Block' },
}

describe('SentinelOne Device Control Health Check Handler', () => {
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
      const result = await healthCheck(ctx([blockUsb], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared rule is present at the scope', async () => {
    await withFetch(
      [envelope([{ id: 'dc-1', ruleName: 'Block mass storage' }, { id: 'dc-2', ruleName: 'Block Bluetooth' }])],
      async () => {
        const result = await healthCheck(ctx([blockUsb, blockBt]))
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('reports the specific rule that has gone missing', async () => {
    await withFetch([envelope([{ id: 'dc-1', ruleName: 'Block mass storage' }])], async () => {
      const result = await healthCheck(ctx([blockUsb, blockBt]))

      expect(result.healthy).toBe(false)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toBe('rule:Block Bluetooth')
    })
  })

  it('matches a live rule whose name differs only by case', async () => {
    await withFetch([envelope([{ id: 'dc-1', ruleName: 'block MASS storage' }])], async () => {
      const result = await healthCheck(ctx([blockUsb]))
      expect(result.healthy).toBe(true)
    })
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([blockUsb]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
