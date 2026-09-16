import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { PREVENTION_PROFILE_ENDPOINTS } from '../_shared'
import {
  API_KEY,
  API_KEY_ID,
  EMPTY_REPLY,
  type ItemInput,
  callsTo,
  cortexError,
  cortexReply,
  deployContext,
  mentionsApiKey,
  objectBody,
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'prevention-profiles'
const GET = PREVENTION_PROFILE_ENDPOINTS.get
const ADD = PREVENTION_PROFILE_ENDPOINTS.add
const EDIT = PREVENTION_PROFILE_ENDPOINTS.edit

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

interface PriorEntry {
  name: string
  prior: Record<string, unknown> | null
}

function previousOf(result: DeployResult): PriorEntry[] {
  const data = result.rollbackData as { previous?: PriorEntry[] } | undefined
  return data?.previous ?? []
}

const MODULES = '{"anti_ransomware":{"action":"block"},"exploit":{"action":"block"}}'

/** The profile as Cortex already holds it — the endpoint protection actually in force. */
const LIVE_PROFILE = {
  id: 55,
  name: 'Servers hardened',
  type: 'prevention',
  is_default: false,
  description: 'set by the previous owner',
  modules: { anti_ransomware: { action: 'report' } },
}

const DECLARED = {
  fields: {
    name: 'Servers hardened',
    profile_type: 'prevention',
    platform: 'windows',
    description: 'managed by Veltrix',
    modules: MODULES,
  },
}

describe('cortex-xdr prevention-profiles deploy handler', () => {
  it('refuses without a credential instead of calling the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([DECLARED], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the connection carries no tenant API FQDN', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([DECLARED], { noHostname: true }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/FQDN/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the live profiles first, with the RPC envelope and the API key headers', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].apiPath).toBe(GET)
      expect(requestData(calls[0])).toEqual({ type: 'prevention' })
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('adds a profile that does not exist yet, with a RAW body and no request_data wrapper', async () => {
    // Unlike every other write in this app, add/edit here send their body
    // directly — wrapping it would make Cortex reject or ignore the whole thing.
    await withFetch([cortexReply([]), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const added = callsTo(calls, ADD)
      expect(added).toHaveLength(1)
      expect(objectBody(added[0])).toEqual({
        name: 'Servers hardened',
        profile_type: 'prevention',
        platform: 'windows',
        description: 'managed by Veltrix',
        modules: { anti_ransomware: { action: 'block' }, exploit: { action: 'block' } },
      })
      expect(objectBody(added[0]).request_data).toBeUndefined()
      expect(callsTo(calls, EDIT)).toHaveLength(0)
      expect(previousOf(result)).toEqual([{ name: 'Servers hardened', prior: null }])
    })
  })

  it('edits an existing profile by its id rather than adding a duplicate', async () => {
    await withFetch([cortexReply({ profiles: [LIVE_PROFILE] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const edited = callsTo(calls, EDIT)
      expect(edited).toHaveLength(1)
      expect(objectBody(edited[0])).toEqual({
        profile_id: 55,
        update_data: {
          name: 'Servers hardened',
          description: 'managed by Veltrix',
          modules: { anti_ransomware: { action: 'block' }, exploit: { action: 'block' } },
        },
      })
      expect(callsTo(calls, ADD)).toHaveLength(0)
      // The prior snapshot is the protection that was actually in force.
      expect(previousOf(result)).toEqual([{ name: 'Servers hardened', prior: LIVE_PROFILE }])
    })
  })

  it('refuses to touch a default profile, and writes nothing', async () => {
    await withFetch([cortexReply([{ ...LIVE_PROFILE, is_default: true }])], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/does not allow editing default profiles/)
      expect(callsTo(calls, ADD)).toHaveLength(0)
      expect(callsTo(calls, EDIT)).toHaveLength(0)
      // The prior is still recorded, so the operator sees what was matched.
      expect(previousOf(result)).toHaveLength(1)
    })
  })

  it('matches an existing profile case-insensitively on its name', async () => {
    await withFetch([cortexReply([LIVE_PROFILE]), cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { ...DECLARED.fields, name: 'servers HARDENED' } }]))

      expect(callsTo(calls, EDIT)).toHaveLength(1)
    })
  })

  it('fails before writing when the modules blob is missing', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, modules: '' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/modules is required/)
      expect(callsTo(calls, ADD)).toHaveLength(0)
    })
  })

  it('fails before writing when the modules blob is a JSON array rather than an object', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, modules: '[1,2]' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/modules must be a JSON object/)
      expect(callsTo(calls, ADD)).toHaveLength(0)
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '' } }, DECLARED]))

      expect(callsTo(calls, ADD)).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['Servers hardened'])
    })
  })

  it('reports the vendor reason and stops at the first rejected profile', async () => {
    await withFetch(
      [EMPTY_REPLY, cortexReply({}), cortexError('unknown module key', 400)],
      async (calls) => {
        const result = await deploy(
          ctx([
            { fields: { ...DECLARED.fields, name: 'First' } },
            { fields: { ...DECLARED.fields, name: 'Second' } },
          ]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Second/)
        expect(result.message).toMatch(/unknown module key/)
        expect(result.artifacts?.applied).toEqual(['First'])
        expect(callsTo(calls, ADD)).toHaveLength(2)
      },
    )
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ETIMEDOUT', async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ETIMEDOUT/)
    })
  })

  it('keeps the API key out of the message, artifacts and rollback state', async () => {
    await withFetch([EMPTY_REPLY, cortexError('invalid API key', 401)], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
      expect(mentionsApiKey(result.artifacts)).toBe(false)
      expect(mentionsApiKey(result.rollbackData)).toBe(false)
    })
  })
})
