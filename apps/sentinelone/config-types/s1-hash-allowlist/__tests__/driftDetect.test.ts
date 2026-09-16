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

const CONFIG_TYPE = 's1-hash-allowlist'
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return driftContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const buildTool: CanvasItemInput = { name: 'Hash 1', fields: { sha1: SHA1, os_type: 'windows' } }

function actorOf(diff: object): { name?: string } | undefined {
  return (diff as { actor?: { name?: string } }).actor
}

describe('SentinelOne Hash Allowlist Drift Detect Handler', () => {
  it('reports no drift and calls nothing without a credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ configTypeId: CONFIG_TYPE, sections: [buildTool], credential: null }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift and calls nothing when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([buildTool], SCOPELESS_SETTINGS))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports a hash removed from the allowlist as critical drift', async () => {
    await withFetch([envelope([]), envelope([])], async () => {
      const result = await driftDetect(ctx([buildTool]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].expected).toBe('allowlisted')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reports no drift while the hash is still allowlisted', async () => {
    await withFetch([envelope([{ id: 'res-1', value: SHA1, osType: 'windows' }])], async (calls) => {
      const result = await driftDetect(ctx([buildTool]))

      expect(result.hasDrift).toBe(false)
      expect(callsTo(calls, '/activities')).toHaveLength(0)
    })
  })

  it('reports an unreachable console as critical drift rather than throwing', async () => {
    await withFetch([apiError('gateway timeout', 504)], async () => {
      const result = await driftDetect(ctx([buildTool]))

      expect(result.diffs[0].field).toBe('sentinelone')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('attributes the removal to the console user who made it', async () => {
    const activity = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: 'Allowlist entry was removed by Alice Admin.',
      userId: 'u-alice',
      data: { username: 'Alice Admin', value: SHA1 },
    }
    await withFetch([envelope([]), envelope([activity])], async () => {
      const result = await driftDetect(ctx([buildTool]))
      expect(actorOf(result.diffs[0])?.name).toBe('Alice Admin')
    })
  })

  it('never attributes drift to the connection\'s own service user', async () => {
    const ourOwnDeploy = {
      id: 'act-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      primaryDescription: 'Allowlist entry was removed by veltrix-svc.',
      userId: 'u-veltrix',
      data: { username: SERVICE_USER, value: SHA1 },
    }
    await withFetch([envelope([]), envelope([ourOwnDeploy])], async () => {
      const result = await driftDetect(ctx([buildTool]))

      expect(result.hasDrift).toBe(true)
      expect(actorOf(result.diffs[0])).toBeUndefined()
    })
  })
})
