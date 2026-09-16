import deploy, { RESTRICTION_TYPE, type HashRollbackEntry } from '../deploy'
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

const CONFIG_TYPE = 's1-hash-allowlist'
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const buildTool: CanvasItemInput = {
  name: 'Hash 1',
  fields: { sha1: SHA1, sha256: SHA256, os_type: 'windows', description: 'In-house build tool' },
}

function previousState(result: { rollbackData?: unknown }): HashRollbackEntry[] {
  return (result.rollbackData as { previousState?: HashRollbackEntry[] } | undefined)?.previousState ?? []
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Hash Allowlist Deploy Handler', () => {
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
      const result = await deploy(ctx([buildTool], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('lists only white_hash restrictions at the configured scope, with the API token', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/restrictions')
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain(`type=${RESTRICTION_TYPE}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('allowlists a hash that is not allowlisted yet', async () => {
    await withFetch([envelope([]), envelope({ id: 'res-new' })], async (calls) => {
      const result = await deploy(ctx([buildTool]))

      expect(result.success).toBe(true)
      const posts = callsTo(calls, '/restrictions').filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0])).toEqual({
        value: SHA1,
        sha256Value: SHA256,
        osType: 'windows',
        type: RESTRICTION_TYPE,
        source: '',
        description: 'In-house build tool',
      })
      expect(createdIds(result)).toEqual(['res-new'])
      expect(previousState(result)[0].existed).toBe(false)
    })
  })

  it('sends an empty sha256 when none is declared rather than omitting the field', async () => {
    await withFetch([envelope([]), envelope({ id: 'res-new' })], async (calls) => {
      await deploy(ctx([{ name: 'Hash 1', fields: { sha1: SHA1, os_type: 'linux' } }]))

      const posts = callsTo(calls, '/restrictions').filter((call) => call.method === 'POST')
      expect(dataOf(posts[0]).sha256Value).toBe('')
    })
  })

  it('does not re-add a hash that is already allowlisted, matching case-insensitively', async () => {
    const live = { id: 'res-1', value: SHA1.toUpperCase(), osType: 'windows', type: RESTRICTION_TYPE }
    await withFetch([envelope([live])], async (calls) => {
      const result = await deploy(ctx([buildTool]))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
      // Recorded as pre-existing so rollback leaves the customer's own entry alone.
      expect(previousState(result)[0].existed).toBe(true)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the add', async () => {
    await withFetch([envelope([]), apiError('hash is already restricted', 400)], async () => {
      const result = await deploy(ctx([buildTool]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/hash is already restricted/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when the add returns no id rather than recording a phantom entry', async () => {
    await withFetch([envelope([]), envelope({})], async () => {
      const result = await deploy(ctx([buildTool]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([buildTool]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/token lacks scope/)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
