import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { ALERT_EXCLUSION_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'alert-exclusions'
const LIST = ALERT_EXCLUSION_ENDPOINTS.list
const CREATE = ALERT_EXCLUSION_ENDPOINTS.create

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

/** An exclusion as the console holds it — the LIVE state a rollback must restore. */
const LIVE_EXCLUSION = {
  name: 'Suppress backup agent',
  comment: 'raised by the backup team',
  disabled: false,
  filter: { field: 'process', value: 'backup.exe' },
  rule_id: 'exc-9',
}

const DECLARED = {
  fields: {
    name: 'Suppress backup agent',
    filter: '{"field":"process","value":"veeam.exe"}',
    comment: 'authored on the canvas',
    disabled: true,
  },
}

describe('cortex-xdr alert-exclusions deploy handler', () => {
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

  it('reads the live exclusions before it writes, with the API key headers on the first call', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].apiPath).toBe(LIST)
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
      expect(calls[1].apiPath).toBe(CREATE)
    })
  })

  it('creates an exclusion that does not exist yet and records no prior state', async () => {
    await withFetch([cortexReply({ exclusions: [] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      expect(requestData(callsTo(calls, CREATE)[0])).toEqual({
        name: 'Suppress backup agent',
        disabled: true,
        filter: { field: 'process', value: 'veeam.exe' },
        comment: 'authored on the canvas',
      })
      expect(result.success).toBe(true)
      expect(previousOf(result)).toEqual([{ name: 'Suppress backup agent', prior: null }])
    })
  })

  it('records the LIVE prior body of an existing exclusion, not the canvas values', async () => {
    await withFetch([cortexReply({ exclusions: [LIVE_EXCLUSION] }), cortexReply({})], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(previousOf(result)).toEqual([
        { name: 'Suppress backup agent', prior: LIVE_EXCLUSION },
      ])
    })
  })

  it('matches a live exclusion carried under the rules key of the reply', async () => {
    // The list shape is unverified, so the reader accepts exclusions / rules / data.
    await withFetch([cortexReply({ rules: [LIVE_EXCLUSION] }), cortexReply({})], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(previousOf(result)[0].prior).toEqual(LIVE_EXCLUSION)
    })
  })

  it('always sends the disabled flag, so an omitted checkbox cannot mean "leave it enabled"', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { name: 'Rule', filter: '{"a":1}' } }]))

      expect(requestData(callsTo(calls, CREATE)[0]).disabled).toBe(false)
    })
  })

  it('skips a canvas item with no name instead of writing a nameless exclusion', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(
        ctx([{ fields: { name: '' } }, { fields: { name: 'Rule', filter: '{"a":1}' } }]),
      )

      expect(callsTo(calls, CREATE)).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['Rule'])
    })
  })

  it('reports the vendor reason and stops at the first rejected exclusion', async () => {
    await withFetch(
      [EMPTY_REPLY, cortexReply({}), cortexError('unknown endpoint', 404)],
      async (calls) => {
        const result = await deploy(
          ctx([
            { fields: { name: 'First', filter: '{"a":1}' } },
            { fields: { name: 'Second', filter: '{"a":2}' } },
          ]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Second/)
        expect(result.message).toMatch(/unknown endpoint/)
        // The honest caveat travels with the failure.
        expect(result.message).toMatch(/speculative/)
        expect(result.artifacts?.applied).toEqual(['First'])
        expect(callsTo(calls, CREATE)).toHaveLength(2)
      },
    )
  })

  it('returns a failed result rather than throwing on an unparseable filter', async () => {
    await withFetch([EMPTY_REPLY], async () => {
      const result = await deploy(ctx([{ fields: { name: 'Rule', filter: '{oops' } }]))

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
