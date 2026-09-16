import healthCheck from '../healthCheck'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-agent-policy'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function setting(key: string, value: string, valueType = 'boolean'): CanvasItemInput {
  return { name: `Setting ${key}`, fields: { setting_key: key, value_type: valueType, value } }
}

describe('SentinelOne Agent Policy Health Check Handler', () => {
  it('fails closed without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('s1_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed at the global scope, where there is no policy to read', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([setting('agentUi.agentUiOn', 'true')], { scope: 'global' }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([setting('agentUi.agentUiOn', 'true')], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every enforced setting still holds its value', async () => {
    await withFetch([envelope({ agentUi: { agentUiOn: true }, threats: { retention: 30 } })], async () => {
      const result = await healthCheck(
        ctx([setting('agentUi.agentUiOn', 'true'), setting('threats.retention', '30', 'number')]),
      )

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
    })
  })

  it('reports the setting that was changed at the console, with both values', async () => {
    await withFetch([envelope({ agentUi: { agentUiOn: false } })], async () => {
      const result = await healthCheck(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(50)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toBe('setting:agentUi.agentUiOn')
      expect(failed[0].message).toContain('is false, expected true')
    })
  })

  it('reports a setting the policy does not carry at all as failing', async () => {
    await withFetch([envelope({})], async () => {
      const result = await healthCheck(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(result.healthy).toBe(false)
      expect(result.checks[1].passed).toBe(false)
      expect(result.checks[1].message).toContain('undefined')
    })
  })

  it('reports an unreadable policy as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
