import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { BIOC_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'biocs'
const GET = BIOC_ENDPOINTS.get
const INSERT = BIOC_ENDPOINTS.insert

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

/** The rule as Cortex already holds it, with the server-assigned rule_id. */
const LIVE_BIOC = {
  rule_id: 4210,
  name: 'LSASS handle access',
  type: 'CREDENTIAL_ACCESS',
  severity: 'SEV_020_LOW',
  status: 'disabled',
  comment: 'muted last quarter',
}

const DECLARED = {
  fields: {
    name: 'LSASS handle access',
    type: 'CREDENTIAL_ACCESS',
    severity: 'SEV_040_HIGH',
    status: 'enabled',
    comment: 'managed by Veltrix',
  },
}

describe('cortex-xdr biocs deploy handler', () => {
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
      expect(sent).toHaveLength(1)
      expect(sent[0].rule_id).toBeUndefined()
      expect(sent[0].name).toBe('LSASS handle access')
      expect(previousOf(result)).toEqual([{ name: 'LSASS handle access', prior: null }])
    })
  })

  it('attaches the live rule_id so an existing rule is UPDATED, not duplicated', async () => {
    // Without the rule_id, /bioc/insert would create a second rule with the same
    // name and the operator would have two detections where they expect one.
    await withFetch([cortexReply({ objects: [LIVE_BIOC] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const sent = requestArray(callsTo(calls, INSERT)[0])
      expect(sent[0].rule_id).toBe(4210)
      expect(sent[0].severity).toBe('SEV_040_HIGH')
      expect(previousOf(result)).toEqual([{ name: 'LSASS handle access', prior: LIVE_BIOC }])
    })
  })

  it('matches a live rule case-insensitively on its name', async () => {
    await withFetch([cortexReply({ objects: [LIVE_BIOC] }), cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { ...DECLARED.fields, name: 'lsass HANDLE access' } }]))

      expect(requestArray(callsTo(calls, INSERT)[0])[0].rule_id).toBe(4210)
    })
  })

  it('defaults the status to enabled rather than leaving a detection off', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { name: 'New rule', type: 'EXECUTION', severity: 'SEV_030_MEDIUM' } }]))

      expect(requestArray(callsTo(calls, INSERT)[0])[0].status).toBe('enabled')
    })
  })

  it('parses the indicator blob into the request body rather than sending the raw string', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { ...DECLARED.fields, indicator: '{"op":"AND"}' } }]))

      expect(requestArray(callsTo(calls, INSERT)[0])[0].indicator).toEqual({ op: 'AND' })
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '' } }, DECLARED]))

      expect(requestArray(callsTo(calls, INSERT)[0])).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['LSASS handle access'])
    })
  })

  it('makes no write call at all when the canvas declares nothing to apply', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/No BIOC rules to apply/)
      expect(callsTo(calls, INSERT)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the bulk insert is rejected', async () => {
    await withFetch([EMPTY_REPLY, cortexError('severity must be a SEV_ value', 400)], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/severity must be a SEV_ value/)
      expect(result.artifacts?.applied).toEqual([])
      expect(previousOf(result)).toHaveLength(1)
    })
  })

  it('returns a failed result rather than throwing on an unparseable indicator blob', async () => {
    await withFetch([EMPTY_REPLY], async () => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, indicator: '{oops' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/failed/i)
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
