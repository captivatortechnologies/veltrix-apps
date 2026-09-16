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

const CONFIG_TYPE = 's1-device-control'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const blockUsb: CanvasItemInput = {
  name: 'Rule 1',
  fields: { rule_name: 'Block mass storage', interface: 'USB', action: 'Block' },
}

const live = {
  id: 'dc-1',
  ruleName: 'Block mass storage',
  interface: 'USB',
  action: 'Block',
  accessPermission: 'Not-Applicable',
  status: 'Enabled',
}

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne Device Control Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [blockUsb], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([blockUsb], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a rule deleted at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Block mass storage')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports a block rule flipped to allow as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, action: 'Allow' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      expect(result.diffs[0].field).toBe('Block mass storage.action')
      expect(result.diffs[0].expected).toBe('Block')
      expect(result.diffs[0].actual).toBe('Allow')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('reports a disabled rule as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, status: 'Disabled' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      const status = result.diffs.filter((diff) => diff.field.endsWith('.status'))
      expect(status).toHaveLength(1)
      expect(status[0].severity).toBe('warning')
    })
  })

  it('reports a widened access permission as informational drift', async () => {
    await withFetch([envelope([{ ...live, accessPermission: 'Read-Write' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      const access = result.diffs.filter((diff) => diff.field.endsWith('.access_permission'))
      expect(access).toHaveLength(1)
      expect(access[0].actual).toBe('Read-Write')
      expect(access[0].severity).toBe('info')
    })
  })

  it('treats a rule with no live access permission as Not-Applicable, not as drift', async () => {
    const withoutAccess = { id: 'dc-1', ruleName: 'Block mass storage', action: 'Block', status: 'Enabled' }
    await withFetch([envelope([withoutAccess])], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('reports no drift while the live rule still matches', async () => {
    await withFetch([envelope([live])], async (calls) => {
      const result = await driftDetect(ctx([blockUsb]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Device rule 'Block mass storage' was updated by Alice Admin.",
      userId: 'u-alice',
      data: { username: 'Alice Admin', ruleName: 'Block mass storage' },
    }
    await withFetch([envelope([{ ...live, action: 'Allow' }]), envelope([activity])], async () => {
      const result = await driftDetect(ctx([blockUsb]))
      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Device rule 'Block mass storage' was updated by veltrix-svc.",
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, ruleName: 'Block mass storage' },
    }
    await withFetch([envelope([{ ...live, action: 'Allow' }]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([blockUsb]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
