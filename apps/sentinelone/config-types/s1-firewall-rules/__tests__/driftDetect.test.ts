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

const CONFIG_TYPE = 's1-firewall-rules'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const blockRdp: CanvasItemInput = {
  name: 'Rule 1',
  fields: {
    name: 'Block inbound RDP',
    action: 'Blocked',
    direction: 'inbound',
    os_type: 'windows',
    service: '3389',
  },
}

const live = {
  id: 'fw-1',
  name: 'Block inbound RDP',
  action: 'Blocked',
  direction: 'inbound',
  status: 'Enabled',
}

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne Firewall Rules Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [blockRdp], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([blockRdp], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a rule deleted at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockRdp]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Block inbound RDP')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports a block rule flipped to allow as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, action: 'Allow' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockRdp]))

      expect(result.diffs[0].field).toBe('Block inbound RDP.action')
      expect(result.diffs[0].expected).toBe('Blocked')
      expect(result.diffs[0].actual).toBe('Allow')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('reports a disabled rule as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, status: 'Disabled' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockRdp]))

      const status = result.diffs.filter((diff) => diff.field.endsWith('.status'))
      expect(status).toHaveLength(1)
      expect(status[0].actual).toBe('Disabled')
      expect(status[0].severity).toBe('warning')
    })
  })

  it('reports a changed direction as informational drift', async () => {
    await withFetch([envelope([{ ...live, direction: 'any' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([blockRdp]))

      const direction = result.diffs.filter((diff) => diff.field.endsWith('.direction'))
      expect(direction).toHaveLength(1)
      expect(direction[0].severity).toBe('info')
    })
  })

  it('reports no drift while the live rule still matches', async () => {
    await withFetch([envelope([live])], async (calls) => {
      const result = await driftDetect(ctx([blockRdp]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([blockRdp]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Firewall rule 'Block inbound RDP' was updated by Alice Admin.",
      userId: 'u-alice',
      data: { username: 'Alice Admin', ruleName: 'Block inbound RDP' },
    }
    await withFetch([envelope([{ ...live, action: 'Allow' }]), envelope([activity])], async () => {
      const result = await driftDetect(ctx([blockRdp]))
      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Firewall rule 'Block inbound RDP' was updated by veltrix-svc.",
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, ruleName: 'Block inbound RDP' },
    }
    await withFetch([envelope([{ ...live, action: 'Allow' }]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([blockRdp]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
