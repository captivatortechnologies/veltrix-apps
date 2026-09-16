import deploy, { type GroupRollbackEntry } from '../deploy'
import { GROUPS_REQUIRE_SITE_SCOPE, DEFAULT_GROUP_NAME } from '../validate'
import {
  ACCOUNT_SETTINGS,
  API_TOKEN,
  SITE_SETTINGS,
  apiError,
  callsTo,
  dataOf,
  deployContext,
  envelope,
  withFetch,
  type CanvasItemInput,
  type RecordedCall,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-groups'

function ctx(sections: CanvasItemInput[], settings: Record<string, unknown> = SITE_SETTINGS) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function group(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Group ${String(fields.name ?? '')}`, fields }
}

function previousState(result: { rollbackData?: unknown }): GroupRollbackEntry[] {
  return ((result.rollbackData as { previousState?: GroupRollbackEntry[] } | undefined)?.previousState ?? [])
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return ((result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? [])
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Groups Deploy Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ configTypeId: CONFIG_TYPE, settings: SITE_SETTINGS, credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses at a non-site scope instead of writing groups to the wrong place', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([group({ name: 'Servers' })], ACCOUNT_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toBe(GROUPS_REQUIRE_SITE_SCOPE)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([group({ name: 'Servers' })], { scope: 'site', scope_id: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the site scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/groups')
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('siteIds=site-1')
    })
  })

  it('creates a group that does not exist yet, under the configured site', async () => {
    await withFetch(
      [envelope([]), envelope({ id: 'grp-new', name: 'Workstations' })],
      async (calls) => {
        const result = await deploy(ctx([group({ name: 'Workstations', inherits: false })]))

        expect(result.success).toBe(true)
        const posts = callsTo(calls, '/groups').filter((call) => call.method === 'POST')
        expect(posts).toHaveLength(1)
        expect(dataOf(posts[0])).toEqual({ name: 'Workstations', siteId: 'site-1', inherits: false })
        expect(previousState(result)).toEqual([{ name: 'Workstations', existed: false, id: 'grp-new' }])
        expect(createdIds(result)).toEqual(['grp-new'])
      },
    )
  })

  it('updates a group that already exists, by id, and records its prior state', async () => {
    await withFetch(
      [envelope([{ id: 'grp-1', name: 'Servers', inherits: false }]), envelope({})],
      async (calls) => {
        const result = await deploy(ctx([group({ name: 'Servers', inherits: true })]))

        expect(result.success).toBe(true)
        const puts = callsTo(calls, '/groups/grp-1')
        expect(puts).toHaveLength(1)
        expect(puts[0].method).toBe('PUT')
        expect(dataOf(puts[0])).toEqual({ name: 'Servers', inherits: true })
        // The prior `inherits` is what rollback restores — capturing the live
        // value rather than the desired one is the whole point.
        // `description: ''` records that the live group had none, which is what
        // lets rollback CLEAR a description a deploy added. Leaving it undefined
        // would make "had none" indistinguishable from "not recorded".
        expect(previousState(result)).toEqual([
          {
            name: 'Servers',
            existed: true,
            id: 'grp-1',
            prior: { name: 'Servers', inherits: false, description: '' },
          },
        ])
        expect(createdIds(result)).toEqual([])
      },
    )
  })

  it('never writes to the site\'s protected Default Group', async () => {
    await withFetch(
      [envelope([{ id: 'grp-default', name: DEFAULT_GROUP_NAME, isDefault: true }])],
      async (calls) => {
        const result = await deploy(ctx([group({ name: DEFAULT_GROUP_NAME })]))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Default Group/)
        expect(writes(calls)).toHaveLength(0)
      },
    )
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), apiError('insufficient permissions', 403)], async () => {
      const result = await deploy(ctx([group({ name: 'Workstations' })]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/insufficient permissions/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom group', async () => {
    await withFetch([envelope([]), envelope({ name: 'Workstations' })], async () => {
      const result = await deploy(ctx([group({ name: 'Workstations' })]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('keeps the rollback state of a failed update so the change can still be reverted', async () => {
    await withFetch(
      [envelope([{ id: 'grp-1', name: 'Servers', inherits: true }]), apiError('conflict', 409)],
      async () => {
        const result = await deploy(ctx([group({ name: 'Servers', inherits: false })]))

        expect(result.success).toBe(false)
        // The prior state was recorded BEFORE the PUT was attempted — a PUT that
        // reports a failure may still have partially applied.
        expect(previousState(result)).toHaveLength(1)
        expect(previousState(result)[0].id).toBe('grp-1')
      },
    )
  })

  it('stops at the first failure and reports how far it got', async () => {
    await withFetch(
      [envelope([]), envelope({ id: 'grp-a' }), apiError('quota exceeded', 400)],
      async (calls) => {
        const result = await deploy(
          ctx([group({ name: 'Alpha' }), group({ name: 'Bravo' }), group({ name: 'Charlie' })]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain('after 1 of 3')
        // Charlie is never attempted once Bravo fails.
        expect(callsTo(calls, '/groups').filter((call) => call.method === 'POST')).toHaveLength(2)
        expect(createdIds(result)).toEqual(['grp-a'])
      },
    )
  })
})
