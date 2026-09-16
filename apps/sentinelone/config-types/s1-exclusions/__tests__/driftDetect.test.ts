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

const CONFIG_TYPE = 's1-exclusions'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const appDir: CanvasItemInput = {
  name: 'Exclusion 1',
  fields: { type: 'path', value: '/opt/app', os_type: 'linux', description: 'App directory' },
}

function actorOf(diff: object): { id?: string; name?: string } | undefined {
  return (diff as { actor?: { id?: string; name?: string } }).actor
}

const live = {
  id: 'exc-1',
  type: 'path',
  value: '/opt/app',
  osType: 'linux',
  description: 'App directory',
  mode: 'disable_all_monitors',
}

describe('SentinelOne Exclusions Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [appDir], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([appDir], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports an exclusion deleted at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([appDir]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('path /opt/app')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports a weakened path mode as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, mode: 'suppress' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([appDir]))

      expect(result.hasDrift).toBe(true)
      const mode = result.diffs.filter((diff) => diff.field.endsWith('.mode'))
      expect(mode).toHaveLength(1)
      expect(mode[0].expected).toBe('disable_all_monitors')
      expect(mode[0].actual).toBe('suppress')
      expect(mode[0].severity).toBe('warning')
    })
  })

  it('reports an edited description as informational drift', async () => {
    await withFetch([envelope([{ ...live, description: 'edited by hand' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([appDir]))

      expect(result.diffs[0].field).toBe('path /opt/app.description')
      expect(result.diffs[0].severity).toBe('info')
    })
  })

  it('reports no drift when the live exclusion still matches', async () => {
    await withFetch([envelope([live])], async (calls) => {
      const result = await driftDetect(ctx([appDir]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      // No drift means no attribution query — the activity log is only read when
      // something actually changed.
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([appDir]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Exclusion '/opt/app' was removed by Alice Admin.",
      userId: 'u-alice',
      data: { username: 'Alice Admin', value: '/opt/app' },
    }
    await withFetch([envelope([]), envelope([activity])], async () => {
      const result = await driftDetect(ctx([appDir]))

      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Exclusion '/opt/app' was updated by veltrix-svc.",
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, value: '/opt/app' },
    }
    await withFetch([envelope([]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([appDir]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
