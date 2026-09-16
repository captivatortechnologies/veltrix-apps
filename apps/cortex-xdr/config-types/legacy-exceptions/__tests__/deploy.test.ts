import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { LEGACY_EXCEPTION_ENDPOINTS } from '../_shared'
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
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'legacy-exceptions'
const FETCH = LEGACY_EXCEPTION_ENDPOINTS.fetch
const ADD = LEGACY_EXCEPTION_ENDPOINTS.add
const EDIT = LEGACY_EXCEPTION_ENDPOINTS.edit

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

interface PriorEntry {
  name: string
  prior: Record<string, unknown> | null
  createdId?: string
}

function previousOf(result: DeployResult): PriorEntry[] {
  const data = result.rollbackData as { previous?: PriorEntry[] } | undefined
  return data?.previous ?? []
}

const CONDITIONS = '{"field":"process_path","op":"EQ","value":"C:/tools/agent.exe"}'

/** The exception as Cortex hands it back from fetch — note rule_name, not name. */
const LIVE_EXCEPTION = {
  id: 'exc-3311',
  rule_name: 'Allow backup agent',
  platform: 'windows',
  module: 12,
  status: 'disabled',
  scope: 'global',
  description: 'left disabled by the previous owner',
  conditions: { field: 'process_path', op: 'EQ', value: 'C:/old/agent.exe' },
}

const DECLARED = {
  fields: {
    name: 'Allow backup agent',
    platform: 'WINDOWS',
    module: 12,
    status: 'enabled',
    scope: 'global',
    description: 'managed by Veltrix',
    conditions: CONDITIONS,
  },
}

describe('cortex-xdr legacy-exceptions deploy handler', () => {
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

  it('fetches the live exceptions before it writes, with the API key headers on the first call', async () => {
    await withFetch([EMPTY_REPLY, cortexReply('new-id')], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].apiPath).toBe(FETCH)
      expect(requestData(calls[0])).toEqual({ search_from: 0, search_to: 1000 })
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('adds an exception that does not exist and captures the id Cortex assigns', async () => {
    await withFetch([cortexReply({ DATA: [] }), cortexReply('exc-9001')], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const added = callsTo(calls, ADD)
      expect(added).toHaveLength(1)
      expect(requestData(added[0])).toEqual({
        name: 'Allow backup agent',
        platform: 'windows',
        module: 12,
        status: 'enabled',
        scope: 'global',
        description: 'managed by Veltrix',
        conditions: { field: 'process_path', op: 'EQ', value: 'C:/tools/agent.exe' },
      })
      expect(callsTo(calls, EDIT)).toHaveLength(0)
      // Without the captured id, rollback has no way to remove what it created.
      expect(previousOf(result)).toEqual([
        { name: 'Allow backup agent', prior: null, createdId: 'exc-9001' },
      ])
    })
  })

  it('edits an existing exception by its exception_id rather than adding a duplicate', async () => {
    await withFetch([cortexReply({ DATA: [LIVE_EXCEPTION] }), cortexReply('ok')], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const edited = callsTo(calls, EDIT)
      expect(edited).toHaveLength(1)
      expect(requestData(edited[0]).exception_id).toBe('exc-3311')
      expect(callsTo(calls, ADD)).toHaveLength(0)
      // The prior snapshot is the console's, not the canvas's.
      expect(previousOf(result)).toEqual([{ name: 'Allow backup agent', prior: LIVE_EXCEPTION }])
    })
  })

  it('matches an existing exception case-insensitively on its rule_name', async () => {
    await withFetch([cortexReply({ DATA: [LIVE_EXCEPTION] }), cortexReply('ok')], async (calls) => {
      await deploy(ctx([{ fields: { ...DECLARED.fields, name: 'allow BACKUP agent' } }]))

      expect(callsTo(calls, EDIT)).toHaveLength(1)
    })
  })

  it('leaves createdId unset when the add response carries no id, instead of inventing one', async () => {
    // Rollback then reports the exception as un-removable rather than deleting
    // something it guessed at.
    await withFetch([EMPTY_REPLY, cortexReply({ ok: true })], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(previousOf(result)[0].createdId).toBeUndefined()
    })
  })

  it('fails before writing when conditions are missing', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, conditions: '' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/conditions is required/)
      expect(callsTo(calls, ADD)).toHaveLength(0)
      expect(callsTo(calls, EDIT)).toHaveLength(0)
    })
  })

  it('fails with the parse reason rather than throwing on invalid conditions JSON', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, conditions: '{oops' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Allow backup agent/)
      expect(callsTo(calls, ADD)).toHaveLength(0)
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_REPLY, cortexReply('id')], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '' } }, DECLARED]))

      expect(callsTo(calls, ADD)).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['Allow backup agent'])
    })
  })

  it('reports the vendor reason and stops at the first rejected exception', async () => {
    await withFetch(
      [EMPTY_REPLY, cortexReply('id-1'), cortexError('module 99 does not exist', 400)],
      async (calls) => {
        const result = await deploy(
          ctx([
            { fields: { ...DECLARED.fields, name: 'First' } },
            { fields: { ...DECLARED.fields, name: 'Second', module: 99 } },
          ]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Second/)
        expect(result.message).toMatch(/module 99 does not exist/)
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
