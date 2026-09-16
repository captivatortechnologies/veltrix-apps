import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'asset-groups'
const GROUPS = `/asset_groups/v1/orgs/${ORG_KEY}/groups`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function group(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const DEPLOYED = group({
  name: 'Windows Servers',
  description: 'prod windows',
  memberType: 'DEVICE',
  query: 'os.equals:WINDOWS',
  policyId: '42',
})

const IN_SYNC = {
  id: 'ag-1',
  name: 'Windows Servers',
  description: 'prod windows',
  member_type: 'DEVICE',
  query: 'os.equals:WINDOWS',
  policy_id: 42,
  status: 'OK',
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black asset-groups driftDetect handler', () => {
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

  it('finds no drift when the live group matches what was deployed', async () => {
    await withFetch([cbJson({ results: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(GROUPS)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted group as critical — the devices it scoped are ungrouped', async () => {
    await withFetch([EMPTY_LIST], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Windows Servers')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags the membership query being rewritten out of band', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, query: 'os.equals:LINUX' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Windows Servers.query')!
      expect(diff.expected).toBe('os.equals:WINDOWS')
      expect(diff.actual).toBe('os.equals:LINUX')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags the policy being detached from the group', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, policy_id: null }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Windows Servers.policy_id')!
      expect(diff.expected).toBe('42')
      expect(diff.actual).toBe('')
    })
  })

  it('flags description and query drift together', async () => {
    await withFetch(
      [cbJson({ results: [{ ...IN_SYNC, description: 'edited', query: 'os.equals:MAC' }] })],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(true)
        expect(fields(result)).toContain('Windows Servers.description')
        expect(fields(result)).toContain('Windows Servers.query')
      },
    )
  })

  it('suppresses field drift while a dynamic group is still UPDATING', async () => {
    await withFetch(
      [cbJson({ results: [{ ...IN_SYNC, status: 'UPDATING', description: 'edited', query: 'os.equals:LINUX' }] })],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        // Dynamic membership re-evaluates asynchronously — reporting mid-flight
        // would alarm on every deploy.
        expect(result.hasDrift).toBe(false)
        expect(result.diffs).toHaveLength(0)
      },
    )
  })

  it('suppresses drift on an updating group whatever case the status arrives in', async () => {
    await withFetch(
      [cbJson({ results: [{ ...IN_SYNC, status: 'updating', query: 'os.equals:LINUX' }] })],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(false)
      },
    )
  })

  it('still flags an UPDATING group that has vanished entirely', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, name: 'Something Else', status: 'UPDATING' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('reads a listing that arrives as a bare array', async () => {
    await withFetch([cbJson([{ ...IN_SYNC, description: 'edited' }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(fields(result)).toContain('Windows Servers.description')
    })
  })

  it('reads a listing that arrives under a groups envelope', async () => {
    await withFetch([cbJson({ groups: [IN_SYNC] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // Missing the envelope would report the group as absent instead.
      expect(result.hasDrift).toBe(false)
    })
  })

  it('matches the live group by name case-insensitively', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, name: 'WINDOWS SERVERS' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
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
