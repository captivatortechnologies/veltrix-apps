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

const CONFIG_TYPE = 's1-star-rules'
const S1QL = 'EventType = "Process Creation"'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const powershell: CanvasItemInput = {
  name: 'Rule 1',
  fields: { name: 'Suspicious PowerShell', s1ql: S1QL, severity: 'High' },
}

const live = { id: 'r-1', name: 'Suspicious PowerShell', severity: 'High', status: 'Active' }

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne STAR Rules Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [powershell], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([powershell], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a rule deleted at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([powershell]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Suspicious PowerShell')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports a downgraded severity as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, severity: 'Low' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([powershell]))

      expect(result.diffs[0].field).toBe('Suspicious PowerShell.severity')
      expect(result.diffs[0].expected).toBe('High')
      expect(result.diffs[0].actual).toBe('Low')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('reports a rule that was switched back to Draft as warning-level drift', async () => {
    await withFetch([envelope([{ ...live, status: 'Draft' }]), envelope([])], async () => {
      const result = await driftDetect(ctx([powershell]))

      const status = result.diffs.filter((diff) => diff.field.endsWith('.status'))
      expect(status).toHaveLength(1)
      expect(status[0].expected).toBe('Active')
      expect(status[0].actual).toBe('Draft')
      expect(status[0].severity).toBe('warning')
    })
  })

  it('reports no drift while the live rule still matches', async () => {
    await withFetch([envelope([live])], async (calls) => {
      const result = await driftDetect(ctx([powershell]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([powershell]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Custom rule 'Suspicious PowerShell' was updated by Alice Admin.",
      userId: 'u-alice',
      data: { username: 'Alice Admin', ruleName: 'Suspicious PowerShell' },
    }
    await withFetch([envelope([{ ...live, severity: 'Low' }]), envelope([activity])], async () => {
      const result = await driftDetect(ctx([powershell]))
      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: "Custom rule 'Suspicious PowerShell' was updated by veltrix-svc.",
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, ruleName: 'Suspicious PowerShell' },
    }
    await withFetch([envelope([{ ...live, severity: 'Low' }]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([powershell]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
