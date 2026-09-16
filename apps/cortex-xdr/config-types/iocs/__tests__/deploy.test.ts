import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { IOC_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'iocs'
const GET_CHANGES = IOC_ENDPOINTS.getChanges
const INSERT = IOC_ENDPOINTS.insert

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

interface PriorEntry {
  indicator: string
  prior: Record<string, unknown> | null
}

function previousOf(result: DeployResult): PriorEntry[] {
  const data = result.rollbackData as { previous?: PriorEntry[] } | undefined
  return data?.previous ?? []
}

const BAD_IP = '203.0.113.7'

/** The indicator as Cortex already holds it — the LIVE state a rollback restores. */
const LIVE_IOC = {
  indicator: BAD_IP,
  type: 'IP',
  severity: 'LOW',
  reputation: 'SUSPICIOUS',
  reliability: 'D',
  comment: 'set by the previous owner',
}

const DECLARED = {
  fields: {
    indicator: BAD_IP,
    type: 'IP',
    severity: 'CRITICAL',
    reputation: 'BAD',
    reliability: 'A',
    comment: 'authored on the canvas',
    expiration_date: '1893456000000',
  },
}

describe('cortex-xdr iocs deploy handler', () => {
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

  it('reads the live indicators from epoch 0 before it writes', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].apiPath).toBe(GET_CHANGES)
      expect(requestData(calls[0])).toEqual({ ts: 0 })
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('upserts every indicator in one bulk call whose request_data is an ARRAY', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(
        ctx([
          DECLARED,
          { fields: { indicator: 'evil.example', type: 'DOMAIN_NAME', severity: 'HIGH' } },
        ]),
      )

      const inserts = callsTo(calls, INSERT)
      expect(inserts).toHaveLength(1)
      const sent = requestArray(inserts[0])
      expect(sent).toHaveLength(2)
      expect(sent[0]).toEqual({
        indicator: BAD_IP,
        type: 'IP',
        severity: 'CRITICAL',
        reputation: 'BAD',
        reliability: 'A',
        comment: 'authored on the canvas',
        expiration_date: 1893456000000,
      })
      // Optional fields the canvas left blank are omitted, not sent as ''.
      expect(sent[1]).toEqual({ indicator: 'evil.example', type: 'DOMAIN_NAME', severity: 'HIGH' })
      expect(result.success).toBe(true)
      expect(result.artifacts?.applied).toEqual([BAD_IP, 'evil.example'])
    })
  })

  it('records the LIVE prior indicator for one that already exists, and null for a new one', async () => {
    await withFetch([cortexReply({ indicators: [LIVE_IOC] }), cortexReply({})], async () => {
      const result = await deploy(
        ctx([DECLARED, { fields: { indicator: 'evil.example', type: 'DOMAIN_NAME', severity: 'HIGH' } }]),
      )

      expect(previousOf(result)).toEqual([
        { indicator: BAD_IP, prior: LIVE_IOC },
        { indicator: 'evil.example', prior: null },
      ])
    })
  })

  it('matches a live indicator case-insensitively', async () => {
    const liveDomain = { indicator: 'EVIL.EXAMPLE', type: 'DOMAIN_NAME', severity: 'LOW' }
    await withFetch([cortexReply([liveDomain]), cortexReply({})], async () => {
      const result = await deploy(
        ctx([{ fields: { indicator: 'evil.example', type: 'DOMAIN_NAME', severity: 'HIGH' } }]),
      )

      expect(previousOf(result)[0].prior).toEqual(liveDomain)
    })
  })

  it('skips a canvas item with no indicator value', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(
        ctx([{ fields: { indicator: '  ', type: 'IP' } }, { fields: { indicator: BAD_IP, type: 'IP' } }]),
      )

      expect(requestArray(callsTo(calls, INSERT)[0])).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual([BAD_IP])
    })
  })

  it('makes no write call at all when the canvas declares nothing to apply', async () => {
    await withFetch([EMPTY_REPLY], async (calls) => {
      const result = await deploy(ctx([]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/No indicators to apply/)
      expect(callsTo(calls, INSERT)).toHaveLength(0)
      expect(previousOf(result)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the bulk insert is rejected', async () => {
    await withFetch([EMPTY_REPLY, cortexError('indicator quota exceeded', 400)], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/indicator quota exceeded/)
      // Nothing landed, so nothing is claimed as applied.
      expect(result.artifacts?.applied).toEqual([])
      // The prior snapshot is still recorded so a rollback can act on it.
      expect(previousOf(result)).toHaveLength(1)
    })
  })

  it('carries the vendor err_extra into the message when Cortex supplies one', async () => {
    await withFetch([EMPTY_REPLY, cortexError('bad request', 400, 'type must be one of HASH, IP')], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.message).toMatch(/bad request/)
      expect(result.message).toMatch(/type must be one of HASH, IP/)
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
