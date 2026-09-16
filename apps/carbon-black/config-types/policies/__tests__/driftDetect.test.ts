import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'policies'
const SUMMARY = `/policyservice/v1/orgs/${ORG_KEY}/policies/summary`

const POLICY_JSON = '{"av_settings":{"onAccessScan":{"enabled":true}},"rules":[]}'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function policy(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const DEPLOYED = policy({ name: 'Standard', description: 'baseline', priorityLevel: 'HIGH', policyJson: POLICY_JSON })

const IN_SYNC = { id: 7, name: 'Standard', description: 'baseline', priority_level: 'HIGH', is_system: false }

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black policies driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live policy matches what was deployed', async () => {
    await withFetch([cbJson({ policies: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(SUMMARY)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted policy as critical — the devices on it fell back to another', async () => {
    await withFetch([cbJson({ policies: [] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Standard')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags the priority level being lowered out of band', async () => {
    await withFetch([cbJson({ policies: [{ ...IN_SYNC, priority_level: 'LOW' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.priority_level')!
      expect(diff.expected).toBe('HIGH')
      expect(diff.actual).toBe('LOW')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags an edited description', async () => {
    await withFetch([cbJson({ policies: [{ ...IN_SYNC, description: 'edited in the console' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.description')!
      expect(diff.expected).toBe('baseline')
      expect(diff.actual).toBe('edited in the console')
    })
  })

  it('flags priority and description drift together', async () => {
    await withFetch(
      [cbJson({ policies: [{ ...IN_SYNC, priority_level: 'LOW', description: 'edited' }] })],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(true)
        expect(fields(result)).toContain('Standard.priority_level')
        expect(fields(result)).toContain('Standard.description')
      },
    )
  })

  it('treats a missing live description as drift against a described policy', async () => {
    await withFetch([cbJson({ policies: [{ id: 7, name: 'Standard', priority_level: 'HIGH' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.description')!
      expect(diff.actual).toBe('')
    })
  })

  it('matches the live policy by name case-insensitively', async () => {
    await withFetch([cbJson({ policies: [{ ...IN_SYNC, name: 'STANDARD' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('reads a bare-array summary response as well as the policies-wrapped one', async () => {
    await withFetch([cbJson([IN_SYNC])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('skips an item whose policy JSON no longer parses rather than calling it absent', async () => {
    await withFetch([cbJson({ policies: [] })], async (calls) => {
      const result = await driftDetect(ctx([policy({ name: 'Broken', priorityLevel: 'LOW', policyJson: '{not json' })]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('reports no drift when the vendor listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })
})
