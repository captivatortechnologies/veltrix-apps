import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { CORRELATION_ENDPOINTS } from '../_shared'
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
  requestArray,
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'correlation-rules'
const GET = CORRELATION_ENDPOINTS.get
const INSERT = CORRELATION_ENDPOINTS.insert

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

const XQL = 'dataset = xdr_data | filter action_process_image_name = "mimikatz.exe"'

/** The rule as Cortex already holds it, with the server-assigned rule_id. */
const LIVE_RULE = {
  rule_id: 909,
  name: 'Credential dumping',
  severity: 'SEV_020_LOW',
  xql_query: 'dataset = xdr_data | filter false',
  is_enabled: false,
  execution_mode: 'SCHEDULED',
}

const DECLARED = {
  fields: {
    name: 'Credential dumping',
    severity: 'SEV_040_HIGH',
    xql_query: XQL,
    execution_mode: 'REAL_TIME',
  },
}

describe('cortex-xdr correlation-rules deploy handler', () => {
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

  it('reads the live rules before it writes, with the API key headers on the first call', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].apiPath).toBe(GET)
      expect(requestData(calls[0])).toEqual({ search_from: 0, search_to: 1000 })
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('creates a rule that does not exist yet, sending no rule_id', async () => {
    await withFetch([cortexReply({ objects: [] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const sent = requestArray(callsTo(calls, INSERT)[0])
      expect(sent[0].rule_id).toBeUndefined()
      expect(sent[0].xql_query).toBe(XQL)
      expect(sent[0].execution_mode).toBe('REAL_TIME')
      expect(previousOf(result)).toEqual([{ name: 'Credential dumping', prior: null }])
    })
  })

  it('attaches the live rule_id so an existing rule is UPDATED, not duplicated', async () => {
    await withFetch([cortexReply({ objects: [LIVE_RULE] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const sent = requestArray(callsTo(calls, INSERT)[0])
      expect(sent[0].rule_id).toBe(909)
      expect(previousOf(result)).toEqual([{ name: 'Credential dumping', prior: LIVE_RULE }])
    })
  })

  it('leaves a rule enabled unless the canvas explicitly disables it', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(requestArray(callsTo(calls, INSERT)[0])[0].is_enabled).toBe(true)
    })
  })

  it('honours an explicitly disabled rule, including the string form the canvas emits', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(
        ctx([
          { fields: { ...DECLARED.fields, name: 'A', is_enabled: false } },
          { fields: { ...DECLARED.fields, name: 'B', is_enabled: 'false' } },
        ]),
      )

      const sent = requestArray(callsTo(calls, INSERT)[0])
      expect(sent[0].is_enabled).toBe(false)
      expect(sent[1].is_enabled).toBe(false)
    })
  })

  it('defaults the execution mode to SCHEDULED when the canvas leaves it blank', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { name: 'A', severity: 'SEV_030_MEDIUM', xql_query: XQL } }]))

      expect(requestArray(callsTo(calls, INSERT)[0])[0].execution_mode).toBe('SCHEDULED')
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '  ' } }, DECLARED]))

      expect(requestArray(callsTo(calls, INSERT)[0])).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['Credential dumping'])
    })
  })

  it('makes no write call at all when the canvas declares nothing to apply', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/No correlation rules to apply/)
      expect(callsTo(calls, INSERT)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the bulk insert is rejected', async () => {
    await withFetch([EMPTY_REPLY, cortexError('XQL syntax error at token 3', 400)], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/XQL syntax error at token 3/)
      expect(result.artifacts?.applied).toEqual([])
      expect(previousOf(result)).toHaveLength(1)
    })
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
