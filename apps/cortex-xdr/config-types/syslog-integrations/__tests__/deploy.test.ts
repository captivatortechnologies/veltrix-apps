import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { SYSLOG_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'syslog-integrations'
const GET = SYSLOG_ENDPOINTS.get
const CREATE = SYSLOG_ENDPOINTS.create
const UPDATE = SYSLOG_ENDPOINTS.update

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

/** The integration as Cortex hands it back — SCREAMING_SNAKE keys on read. */
const LIVE_INTEGRATION = {
  SYSLOG_INTEGRATION_ID: 31,
  SYSLOG_INTEGRATION_NAME: 'SOC collector',
  SYSLOG_INTEGRATION_ADDRESS: 'old-collector.internal',
  SYSLOG_INTEGRATION_PORT: 514,
  SYSLOG_INTEGRATION_PROTOCOL: 'UDP',
  FACILITY: 'LOCAL0',
}

const DECLARED = {
  fields: {
    name: 'SOC collector',
    address: 'collector.internal',
    port: 6514,
    protocol: 'tls',
    facility: 'LOCAL7',
  },
}

describe('cortex-xdr syslog-integrations deploy handler', () => {
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

  it('reads the live integrations before it writes, with the API key headers on the first call', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].apiPath).toBe(GET)
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('creates an integration that does not exist yet, sending no syslog_id', async () => {
    await withFetch([cortexReply({ objects: [] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const created = callsTo(calls, CREATE)
      expect(created).toHaveLength(1)
      expect(requestData(created[0])).toEqual({
        name: 'SOC collector',
        address: 'collector.internal',
        port: 6514,
        protocol: 'TLS',
        facility: 'LOCAL7',
      })
      expect(callsTo(calls, UPDATE)).toHaveLength(0)
      expect(previousOf(result)).toEqual([{ name: 'SOC collector', prior: null }])
    })
  })

  it('updates an existing integration by its syslog_id rather than creating a duplicate', async () => {
    // A duplicate collector silently doubles every forwarded alert.
    await withFetch([cortexReply({ objects: [LIVE_INTEGRATION] }), cortexReply({})], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const updated = callsTo(calls, UPDATE)
      expect(updated).toHaveLength(1)
      expect(requestData(updated[0]).syslog_id).toBe('31')
      expect(requestData(updated[0]).address).toBe('collector.internal')
      expect(callsTo(calls, CREATE)).toHaveLength(0)
      expect(previousOf(result)).toEqual([{ name: 'SOC collector', prior: LIVE_INTEGRATION }])
    })
  })

  it('matches an existing integration case-insensitively on its name', async () => {
    await withFetch([cortexReply({ objects: [LIVE_INTEGRATION] }), cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { ...DECLARED.fields, name: 'soc COLLECTOR' } }]))

      expect(callsTo(calls, UPDATE)).toHaveLength(1)
    })
  })

  it('defaults the protocol to TCP rather than sending a blank one', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { name: 'A', address: 'a.internal', port: 514 } }]))

      expect(requestData(callsTo(calls, CREATE)[0]).protocol).toBe('TCP')
    })
  })

  it('omits security_info entirely when no TLS material was authored', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(requestData(callsTo(calls, CREATE)[0]).security_info).toBeUndefined()
    })
  })

  it('carries the TLS certificate material when it is authored', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(
        ctx([
          {
            fields: {
              ...DECLARED.fields,
              certificate_name: 'soc-ca',
              certificate_content: '-----BEGIN CERTIFICATE-----',
              ignore_cert_errors: true,
            },
          },
        ]),
      )

      expect(requestData(callsTo(calls, CREATE)[0]).security_info).toEqual({
        certificate_name: 'soc-ca',
        certificate_content: '-----BEGIN CERTIFICATE-----',
        ignore_cert_errors: true,
      })
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '' } }, DECLARED]))

      expect(callsTo(calls, CREATE)).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['SOC collector'])
    })
  })

  it('reports the vendor reason and stops at the first rejected integration', async () => {
    await withFetch(
      [EMPTY_REPLY, cortexReply({}), cortexError('port 0 is not valid', 400)],
      async (calls) => {
        const result = await deploy(
          ctx([
            { fields: { ...DECLARED.fields, name: 'First' } },
            { fields: { ...DECLARED.fields, name: 'Second', port: 0 } },
          ]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Second/)
        expect(result.message).toMatch(/port 0 is not valid/)
        expect(result.artifacts?.applied).toEqual(['First'])
        expect(callsTo(calls, CREATE)).toHaveLength(2)
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
