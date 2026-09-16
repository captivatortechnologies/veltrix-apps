import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { EXTERNAL_APPLICATION_BASE } from '../_shared'
import {
  API_KEY,
  API_KEY_ID,
  EMPTY_DATA,
  type ItemInput,
  callsToPath,
  deployContext,
  mentionsApiKey,
  objectBody,
  platformError,
  platformJson,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'external-applications'
const BASE = EXTERNAL_APPLICATION_BASE

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

interface PriorEntry {
  name: string
  prior: Record<string, unknown> | null
  created?: { application_id: number; application_type: string }
}

function previousOf(result: DeployResult): PriorEntry[] {
  const data = result.rollbackData as { previous?: PriorEntry[] } | undefined
  return data?.previous ?? []
}

const CONNECTION_CONFIG = '{"url":"https://hooks.example/soc","auth_header":"X-Token"}'

/** The application as Cortex already holds it. */
const LIVE_APP = {
  application_id: 88,
  name: 'SOC webhook',
  description: 'set by the previous owner',
  application_type: 'webhook',
  connection_config: { url: 'https://hooks.example/old' },
}

const DECLARED = {
  fields: {
    name: 'SOC webhook',
    application_type: 'WEBHOOK',
    description: 'managed by Veltrix',
    connection_config: CONNECTION_CONFIG,
  },
}

describe('cortex-xdr external-applications deploy handler', () => {
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

  it('lists with a plain GET on the platform path, carrying the API key headers', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: {} })], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(BASE)
      // These endpoints carry no /public_api/v1 prefix and no RPC envelope.
      expect(calls[0].apiPath).toBe(BASE)
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
      expect(calls[0].body).toBe('')
    })
  })

  it('creates an application that does not exist yet, POSTing a bare JSON body', async () => {
    await withFetch(
      [EMPTY_DATA, platformJson({ data: { application_id: 101, application_type: 'webhook' } })],
      async (calls) => {
        const result = await deploy(ctx([DECLARED]))

        const created = calls.filter((c) => c.method === 'POST')
        expect(created).toHaveLength(1)
        expect(created[0].path).toBe(BASE)
        expect(objectBody(created[0])).toEqual({
          name: 'SOC webhook',
          application_type: 'webhook',
          description: 'managed by Veltrix',
          connection_config: { url: 'https://hooks.example/soc', auth_header: 'X-Token' },
        })
        expect(objectBody(created[0]).request_data).toBeUndefined()
        // The id Cortex assigns is the only handle rollback has to delete it.
        expect(previousOf(result)).toEqual([
          {
            name: 'SOC webhook',
            prior: null,
            created: { application_id: 101, application_type: 'webhook' },
          },
        ])
      },
    )
  })

  it('updates an existing application by PUTting to its id path', async () => {
    await withFetch([platformJson({ data: [LIVE_APP] }), platformJson({ data: {} })], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const updated = calls.filter((c) => c.method === 'PUT')
      expect(updated).toHaveLength(1)
      expect(updated[0].path).toBe(`${BASE}/88`)
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
      expect(previousOf(result)).toEqual([{ name: 'SOC webhook', prior: LIVE_APP }])
    })
  })

  it('records no created handle for an application it only updated', async () => {
    await withFetch([platformJson({ data: [LIVE_APP] }), platformJson({ data: {} })], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(previousOf(result)[0].created).toBeUndefined()
    })
  })

  it('matches an existing application case-insensitively on its name', async () => {
    await withFetch([platformJson({ data: [LIVE_APP] }), platformJson({ data: {} })], async (calls) => {
      await deploy(ctx([{ fields: { ...DECLARED.fields, name: 'soc WEBHOOK' } }]))

      expect(callsToPath(calls, `${BASE}/88`)).toHaveLength(1)
    })
  })

  it('leaves the created handle unset when the create response carries no id', async () => {
    // Rollback then reports it as un-removable rather than deleting a guess.
    await withFetch([EMPTY_DATA, platformJson({ data: { name: 'SOC webhook' } })], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(previousOf(result)[0].created).toBeUndefined()
    })
  })

  it('sends an empty connection_config when the canvas leaves it blank', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: {} })], async (calls) => {
      await deploy(ctx([{ fields: { name: 'A', application_type: 'syslog', connection_config: '' } }]))

      expect(objectBody(calls[1]).connection_config).toEqual({})
    })
  })

  it('fails before writing when connection_config is not a JSON object', async () => {
    await withFetch([EMPTY_DATA], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, connection_config: '[1,2]' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/connection_config must be a JSON object/)
      expect(calls).toHaveLength(1)
    })
  })

  it('fails with the parse reason rather than throwing on invalid connection_config JSON', async () => {
    await withFetch([EMPTY_DATA], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, connection_config: '{oops' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/SOC webhook/)
      expect(calls).toHaveLength(1)
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: {} })], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '' } }, DECLARED]))

      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['SOC webhook'])
    })
  })

  it('reports the vendor reason and stops at the first rejected application', async () => {
    await withFetch(
      [EMPTY_DATA, platformJson({ data: {} }), platformError('connection_config missing url', 422)],
      async (calls) => {
        const result = await deploy(
          ctx([
            { fields: { ...DECLARED.fields, name: 'First' } },
            { fields: { ...DECLARED.fields, name: 'Second' } },
          ]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Second/)
        expect(result.message).toMatch(/connection_config missing url/)
        expect(result.artifacts?.applied).toEqual(['First'])
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
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
    await withFetch([EMPTY_DATA, platformError('invalid API key', 401)], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
      expect(mentionsApiKey(result.artifacts)).toBe(false)
      expect(mentionsApiKey(result.rollbackData)).toBe(false)
    })
  })
})
