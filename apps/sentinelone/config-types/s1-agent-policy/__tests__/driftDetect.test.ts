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

const CONFIG_TYPE = 's1-agent-policy'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function setting(key: string, value: string, valueType = 'boolean'): CanvasItemInput {
  return { name: `Setting ${key}`, fields: { setting_key: key, value_type: valueType, value } }
}

const agentUiOn = setting('agentUi.agentUiOn', 'true')

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne Agent Policy Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [agentUiOn], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing at the global scope', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([agentUiOn], { scope: 'global' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([agentUiOn], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a setting changed at the console as warning-level drift', async () => {
    await withFetch([envelope({ agentUi: { agentUiOn: false } }), envelope([])], async () => {
      const result = await driftDetect(ctx([agentUiOn]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('agentUi.agentUiOn')
      expect(result.diffs[0].expected).toBe('true')
      expect(result.diffs[0].actual).toBe('false')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('reports a setting the policy no longer carries as "not set"', async () => {
    await withFetch([envelope({}), envelope([])], async () => {
      const result = await driftDetect(ctx([agentUiOn]))

      expect(result.diffs[0].actual).toBe('not set')
    })
  })

  it('reports no drift while every enforced setting still holds', async () => {
    await withFetch([envelope({ agentUi: { agentUiOn: true } })], async (calls) => {
      const result = await driftDetect(ctx([agentUiOn]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreadable policy as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([agentUiOn]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the policy change to the console user, correlated by scope id', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: 'Policy was updated by Alice Admin.',
      userId: 'u-alice',
      data: { username: 'Alice Admin' },
      accountId: 'act-1',
    }
    await withFetch([envelope({ agentUi: { agentUiOn: false } }), envelope([activity])], async () => {
      const result = await driftDetect(ctx([agentUiOn]))

      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: 'Policy was updated by veltrix-svc.',
      userId: 'u-veltrix',
      data: { username: SERVICE_USER },
      accountId: 'act-1',
    }
    await withFetch([envelope({ agentUi: { agentUiOn: false } }), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([agentUiOn]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
