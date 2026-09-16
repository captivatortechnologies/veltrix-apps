import driftDetect from '../driftDetect'
import {
  SERVICE_USER,
  SITE_SETTINGS,
  apiError,
  callsTo,
  driftContext,
  envelope,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-groups'

function ctx(sections: CanvasItemInput[], settings: Record<string, unknown> = SITE_SETTINGS) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const servers: CanvasItemInput = { name: 'Group 1', fields: { name: 'Servers', inherits: true } }

/** The `actor` attribution is set structurally — the SDK build's DriftDiff predates it. */
function actorOf(diff: object): { id?: string; name?: string; at?: string } | undefined {
  return (diff as { actor?: { id?: string; name?: string; at?: string } }).actor
}

/** A human, non-Veltrix change to the Servers group, as the Activities API returns it. */
const humanChange = {
  id: 'act-1',
  activityType: 5021,
  createdAt: '2026-08-01T10:00:00.000Z',
  primaryDescription: "Group 'Servers' was deleted by Alice Admin.",
  userId: 'u-alice',
  data: { username: 'Alice Admin', groupName: 'Servers' },
}

describe('SentinelOne Groups Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({
          configTypeId: CONFIG_TYPE,
          sections: [servers],
          settings: SITE_SETTINGS,
          credential: null,
        }),
      )
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([servers], { scope: 'site', scope_id: '' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when nothing is declared', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([]))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a group deleted at the console as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([servers]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Servers')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports a flipped policy-inheritance flag', async () => {
    await withFetch(
      [envelope([{ id: 'grp-1', name: 'Servers', inherits: false }]), envelope([])],
      async () => {
        const result = await driftDetect(ctx([servers]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs[0].field).toBe('Servers.inherits')
        expect(result.diffs[0].expected).toBe('true')
        expect(result.diffs[0].actual).toBe('false')
        expect(result.diffs[0].severity).toBe('info')
      },
    )
  })

  it('treats a group with no live inherits flag as inheriting, not as drift', async () => {
    await withFetch([envelope([{ id: 'grp-1', name: 'Servers' }])], async () => {
      const result = await driftDetect(ctx([servers]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([servers]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].actual).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the drift to the console user who made the change', async () => {
    await withFetch([envelope([]), envelope([humanChange])], async (calls) => {
      const result = await driftDetect(ctx([servers]))

      expect(callsTo(calls, '/activities')).toHaveLength(1)
      const actor = actorOf(result.diffs[0])
      expect(actor).toBeDefined()
      expect(actor?.id).toBe('u-alice')
      expect(actor?.name).toBe('Alice Admin')
      expect(actor?.at).toBe('2026-08-01T10:00:00.000Z')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      ...humanChange,
      userId: 'u-veltrix',
      primaryDescription: "Group 'Servers' was updated by veltrix-svc.",
      data: { username: SERVICE_USER, groupName: 'Servers' },
    }
    await withFetch([envelope([]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([servers]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
