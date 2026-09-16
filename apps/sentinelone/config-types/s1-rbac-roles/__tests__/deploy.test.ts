import deploy, { type RbacRoleRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  SCOPELESS_SETTINGS,
  apiError,
  callsTo,
  dataOf,
  deployContext,
  envelope,
  filterOf,
  withFetch,
  type CanvasItemInput,
  type RecordedCall,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-rbac-roles'
const ROLES = '/rbac/roles'
const TEMPLATE = '/rbac/role'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function role(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Role ${String(fields.name ?? '')}`, fields }
}

const analyst = role({
  name: 'SOC Analyst',
  description: 'Read-only plus mitigation',
  permissions: { 'threats.mitigate': 'true' },
})

function previousState(result: { rollbackData?: unknown }): RbacRoleRollbackEntry[] {
  return (
    (result.rollbackData as { previousState?: RbacRoleRollbackEntry[] } | undefined)?.previousState ?? []
  )
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

function permissionsOf(call: RecordedCall | undefined): Record<string, unknown> {
  const permissions = dataOf(call).permissions
  return permissions && typeof permissions === 'object' ? (permissions as Record<string, unknown>) : {}
}

describe('SentinelOne RBAC Roles Deploy Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([analyst], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the configured scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(ROLES)
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('creates a new role from the scope\'s permission template, merging only the declared keys', async () => {
    const template = { permissions: { threats: { view: true, mitigate: false }, agents: { reboot: false } } }
    await withFetch([envelope([]), envelope(template), envelope({ id: 'role-new' })], async (calls) => {
      const result = await deploy(ctx([analyst]))

      expect(result.success).toBe(true)
      expect(callsTo(calls, TEMPLATE)).toHaveLength(1)
      const posts = callsTo(calls, ROLES).filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0]).name).toBe('SOC Analyst')
      expect(dataOf(posts[0]).description).toBe('Read-only plus mitigation')
      // Everything the tenant's own template carried survives; only the declared
      // dot-path is overridden — this app never guesses at the permission tree.
      expect(permissionsOf(posts[0])).toEqual({
        threats: { view: true, mitigate: true },
        agents: { reboot: false },
      })
      expect(createdIds(result)).toEqual(['role-new'])
      expect(previousState(result)[0].existed).toBe(false)
    })
  })

  it('reads an existing role\'s full detail before updating and merges into it', async () => {
    const detail = {
      name: 'SOC Analyst',
      description: 'original',
      permissions: { threats: { view: true, mitigate: false }, reports: { export: true } },
    }
    await withFetch([envelope([{ id: 'role-1', name: 'SOC Analyst' }]), envelope(detail), envelope({})], async (calls) => {
      const result = await deploy(ctx([analyst]))

      expect(result.success).toBe(true)
      expect(callsTo(calls, '/rbac/role/role-1')).toHaveLength(1)
      const puts = callsTo(calls, ROLES).filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0]).id).toBe('role-1')
      expect(permissionsOf(puts[0])).toEqual({
        threats: { view: true, mitigate: true },
        reports: { export: true },
      })
      // The whole pre-deploy detail is what rollback restores.
      expect(previousState(result)[0].prior).toEqual(detail)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('treats an un-wrapped permission tree as the baseline rather than losing it', async () => {
    const detail = { threats: { view: true, mitigate: false } }
    await withFetch([envelope([{ id: 'role-1', name: 'SOC Analyst' }]), envelope(detail), envelope({})], async (calls) => {
      await deploy(ctx([analyst]))

      const puts = callsTo(calls, ROLES).filter((call) => call.method === 'PUT')
      expect(permissionsOf(puts[0])).toEqual({ threats: { view: true, mitigate: true } })
    })
  })

  it('matches an existing role whose name differs only by case', async () => {
    await withFetch(
      [envelope([{ id: 'role-1', name: 'soc ANALYST' }]), envelope({ permissions: {} }), envelope({})],
      async (calls) => {
        await deploy(ctx([analyst]))

        expect(callsTo(calls, ROLES).filter((call) => call.method === 'PUT')).toHaveLength(1)
        expect(callsTo(calls, ROLES).filter((call) => call.method === 'POST')).toHaveLength(0)
      },
    )
  })

  it('never writes a role when the permission template cannot be read', async () => {
    await withFetch([envelope([]), apiError('template unavailable', 500)], async (calls) => {
      const result = await deploy(ctx([analyst]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/template unavailable/)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('never writes a role when its current detail cannot be read', async () => {
    await withFetch(
      [envelope([{ id: 'role-1', name: 'SOC Analyst' }]), apiError('detail unavailable', 500)],
      async (calls) => {
        const result = await deploy(ctx([analyst]))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/detail unavailable/)
        expect(writes(calls)).toHaveLength(0)
        // Nothing was captured, because nothing was changed.
        expect(previousState(result)).toEqual([])
      },
    )
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), envelope({ permissions: {} }), apiError('role name in use', 409)], async () => {
      const result = await deploy(ctx([analyst]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/role name in use/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom role', async () => {
    await withFetch([envelope([]), envelope({ permissions: {} }), envelope({})], async () => {
      const result = await deploy(ctx([analyst]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([analyst]))

      expect(result.success).toBe(false)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
