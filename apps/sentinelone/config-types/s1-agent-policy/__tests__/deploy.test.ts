import deploy from '../deploy'
import {
  API_TOKEN,
  SCOPELESS_SETTINGS,
  apiError,
  callsTo,
  dataOf,
  deployContext,
  envelope,
  withFetch,
  type CanvasItemInput,
  type RecordedCall,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-agent-policy'
const POLICY_PATH = '/accounts/act-1/policy'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function setting(key: string, value: string, valueType = 'boolean'): CanvasItemInput {
  return { name: `Setting ${key}`, fields: { setting_key: key, value_type: valueType, value } }
}

function rollbackData(result: { rollbackData?: unknown }): {
  priorPolicy?: Record<string, unknown>
  path?: string
} {
  return (result.rollbackData as { priorPolicy?: Record<string, unknown>; path?: string } | undefined) ?? {}
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Agent Policy Deploy Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses at the global scope — the policy is per account/site/group', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([setting('agentUi.agentUiOn', 'true')], { scope: 'global' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/account, site or group/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([setting('agentUi.agentUiOn', 'true')], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the scope policy and writes it back to the same path, authenticated', async () => {
    await withFetch([envelope({ keep: 'yes' }), envelope({})], async (calls) => {
      const result = await deploy(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(POLICY_PATH)
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[1].method).toBe('PUT')
      expect(calls[1].path).toBe(POLICY_PATH)
    })
  })

  it('merges the declared settings into the live policy without dropping the rest of it', async () => {
    const current = { agentUi: { agentUiOn: false, other: 'keep' }, unrelated: { deep: true } }
    await withFetch([envelope(current), envelope({})], async (calls) => {
      await deploy(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(dataOf(calls[1])).toEqual({
        agentUi: { agentUiOn: true, other: 'keep' },
        unrelated: { deep: true },
      })
    })
  })

  it('coerces each declared value to its declared type', async () => {
    await withFetch([envelope({}), envelope({})], async (calls) => {
      await deploy(
        ctx([
          setting('a.flag', 'true'),
          setting('a.count', '30', 'number'),
          setting('a.label', 'strict', 'string'),
        ]),
      )

      expect(dataOf(calls[1])).toEqual({ a: { flag: true, count: 30, label: 'strict' } })
    })
  })

  it('strips the deprecated top-level keys the API misbehaves on', async () => {
    const current = { agentNotification: { x: 1 }, agentUiOn: true, keep: 'yes' }
    await withFetch([envelope(current), envelope({})], async (calls) => {
      await deploy(ctx([setting('keep', 'no', 'string')]))

      expect(dataOf(calls[1])).toEqual({ keep: 'no' })
    })
  })

  it('records the whole pre-deploy policy, and its path, for rollback', async () => {
    const current = { agentUi: { agentUiOn: false }, agentNotification: { x: 1 } }
    await withFetch([envelope(current), envelope({})], async () => {
      const result = await deploy(ctx([setting('agentUi.agentUiOn', 'true')]))

      // The captured policy is the UNMODIFIED live object — the merge must not
      // leak into it, or rollback would restore the change it is undoing.
      expect(rollbackData(result).priorPolicy).toEqual(current)
      expect(rollbackData(result).path).toBe(POLICY_PATH)
    })
  })

  it('reports failure rather than throwing when the policy write is rejected', async () => {
    await withFetch([envelope({}), apiError('policy is locked', 409)], async () => {
      const result = await deploy(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/policy is locked/)
    })
  })

  it('never writes when the policy cannot be read first', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([setting('agentUi.agentUiOn', 'true')]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read the agent policy/)
      expect(writes(calls)).toHaveLength(0)
      expect(callsTo(calls, POLICY_PATH)).toHaveLength(1)
    })
  })
})
