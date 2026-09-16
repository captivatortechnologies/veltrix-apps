import deploy, { type ExclusionRollbackEntry } from '../deploy'
import {
  ACCOUNT_SETTINGS,
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

const CONFIG_TYPE = 's1-exclusions'

function ctx(sections: CanvasItemInput[], settings: Record<string, unknown> = ACCOUNT_SETTINGS) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function exclusion(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Exclusion ${String(fields.value ?? '')}`, fields }
}

const appDir = exclusion({
  type: 'path',
  value: '/opt/app',
  os_type: 'linux',
  description: 'App directory',
})

function previousState(result: { rollbackData?: unknown }): ExclusionRollbackEntry[] {
  return (result.rollbackData as { previousState?: ExclusionRollbackEntry[] } | undefined)?.previousState ?? []
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Exclusions Deploy Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset instead of writing to the wrong scope', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([appDir], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the configured scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/exclusions')
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('creates an exclusion that does not exist yet, scoped by filter', async () => {
    await withFetch([envelope([]), envelope({ id: 'exc-new' })], async (calls) => {
      const result = await deploy(ctx([appDir]))

      expect(result.success).toBe(true)
      const posts = callsTo(calls, '/exclusions').filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0])).toEqual({
        type: 'path',
        value: '/opt/app',
        osType: 'linux',
        source: 'user',
        actions: ['detect'],
        description: 'App directory',
        mode: 'disable_all_monitors',
        pathExclusionType: 'folder',
      })
      expect(createdIds(result)).toEqual(['exc-new'])
      expect(previousState(result)[0].existed).toBe(false)
    })
  })

  it('omits the path-only fields on a non-path exclusion', async () => {
    await withFetch([envelope([]), envelope({ id: 'exc-new' })], async (calls) => {
      await deploy(ctx([exclusion({ type: 'browser', value: 'chrome', os_type: 'windows' })]))

      const posts = callsTo(calls, '/exclusions').filter((call) => call.method === 'POST')
      expect(dataOf(posts[0])).toEqual({
        type: 'browser',
        value: 'chrome',
        osType: 'windows',
        source: 'user',
        actions: ['detect'],
        description: '',
      })
    })
  })

  it('updates an exclusion matched on its (type, value, OS) key and records its prior body', async () => {
    const live = {
      id: 'exc-1',
      type: 'path',
      value: '/opt/app',
      osType: 'linux',
      mode: 'suppress',
      description: 'old',
      source: 'user',
    }
    await withFetch([envelope([live]), envelope({})], async (calls) => {
      const result = await deploy(ctx([appDir]))

      expect(result.success).toBe(true)
      const puts = callsTo(calls, '/exclusions').filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0]).id).toBe('exc-1')
      expect(dataOf(puts[0]).description).toBe('App directory')
      expect(previousState(result)[0].existed).toBe(true)
      expect(previousState(result)[0].prior).toEqual(live)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('never modifies a predefined (vendor-managed) exclusion', async () => {
    const predefined = { id: 'exc-1', type: 'path', value: '/opt/app', osType: 'linux', source: 'cloud' }
    await withFetch([envelope([predefined])], async (calls) => {
      const result = await deploy(ctx([appDir]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/predefined/)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), apiError('exclusion value is invalid', 400)], async () => {
      const result = await deploy(ctx([appDir]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/exclusion value is invalid/)
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom exclusion', async () => {
    await withFetch([envelope([]), envelope({})], async () => {
      const result = await deploy(ctx([appDir]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([appDir]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/token lacks scope/)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
