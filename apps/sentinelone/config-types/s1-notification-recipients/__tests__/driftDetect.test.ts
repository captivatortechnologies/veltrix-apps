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

const CONFIG_TYPE = 's1-notification-recipients'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const soc: CanvasItemInput = {
  name: 'Recipient 1',
  fields: { email: 'soc@example.com', name: 'SOC Team', sms: '+15550001111' },
}

const live = { id: 'rcp-1', email: 'soc@example.com', name: 'SOC Team', sms: '+15550001111' }

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne Notification Recipients Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [soc], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([soc], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing at the unsupported group scope', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([soc], { scope: 'group', scope_id: 'grp-1' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a recipient removed at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([soc]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('soc@example.com')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports an edited display name and a cleared SMS number', async () => {
    await withFetch([envelope([{ ...live, name: 'Renamed', sms: '' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([soc]))

      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].field).toBe('soc@example.com.name')
      expect(result.diffs[0].actual).toBe('Renamed')
      expect(result.diffs[1].field).toBe('soc@example.com.sms')
      expect(result.diffs[1].actual).toBe('not set')
      expect(result.diffs[1].severity).toBe('info')
    })
  })

  it('reports no drift while the live recipient still matches', async () => {
    await withFetch([envelope([live])], async (calls) => {
      const result = await driftDetect(ctx([soc]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([soc]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: 'Notification recipient was removed by Alice Admin.',
      userId: 'u-alice',
      data: { username: 'Alice Admin', email: 'soc@example.com' },
    }
    await withFetch([envelope([]), envelope([activity])], async () => {
      const result = await driftDetect(ctx([soc]))
      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: 'Notification recipient was removed by veltrix-svc.',
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, email: 'soc@example.com' },
    }
    await withFetch([envelope([]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([soc]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
