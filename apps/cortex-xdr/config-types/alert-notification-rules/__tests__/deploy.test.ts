import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { NOTIFICATION_RULE_ENDPOINTS } from '../_shared'
import {
  API_KEY,
  API_KEY_ID,
  EMPTY_DATA,
  type ItemInput,
  deployContext,
  mentionsApiKey,
  objectBody,
  platformError,
  platformJson,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'alert-notification-rules'
const LIST = NOTIFICATION_RULE_ENDPOINTS.list
const CREATE = NOTIFICATION_RULE_ENDPOINTS.create
const UUID = '7f1c-uuid'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

interface PriorEntry {
  name: string
  prior: Record<string, unknown> | null
  createdUuid?: string
}

function previousOf(result: DeployResult): PriorEntry[] {
  const data = result.rollbackData as { previous?: PriorEntry[] } | undefined
  return data?.previous ?? []
}

/** The rule as Cortex already holds it. */
const LIVE_RULE = {
  rule_uuid: UUID,
  name: 'Page the SOC',
  description: 'set by the previous owner',
  forward_type: 'alert',
  time_zone: 'America/New_York',
  enabled: false,
}

const DECLARED = {
  fields: {
    name: 'Page the SOC',
    forward_type: 'alert',
    filter: '{"severity":["high","critical"]}',
    description: 'managed by Veltrix',
    email_distribution_list: ['soc@example.com'],
    time_zone: 'UTC',
  },
}

describe('cortex-xdr alert-notification-rules deploy handler', () => {
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
    await withFetch([EMPTY_DATA, platformJson({ data: { rule_uuid: UUID } })], async (calls) => {
      await deploy(ctx([DECLARED]))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(LIST)
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('creates a rule that does not exist yet, POSTing a bare JSON body', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: { rule_uuid: UUID } })], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      const created = calls.filter((c) => c.method === 'POST')
      expect(created).toHaveLength(1)
      expect(created[0].path).toBe(CREATE)
      expect(objectBody(created[0])).toEqual({
        name: 'Page the SOC',
        forward_type: 'alert',
        filter: { severity: ['high', 'critical'] },
        description: 'managed by Veltrix',
        forward_source: { email: { distribution_list: ['soc@example.com'] } },
        time_zone: 'UTC',
      })
      expect(previousOf(result)).toEqual([
        { name: 'Page the SOC', prior: null, createdUuid: UUID },
      ])
    })
  })

  it('updates an existing rule by PUTting to its uuid path', async () => {
    await withFetch(
      [platformJson({ data: [LIVE_RULE] }), platformJson({ data: {} }), platformJson({ data: {} })],
      async (calls) => {
        const result = await deploy(ctx([DECLARED]))

        const updated = calls.filter((c) => c.method === 'PUT')
        expect(updated).toHaveLength(1)
        expect(updated[0].path).toBe(NOTIFICATION_RULE_ENDPOINTS.ruleById(UUID))
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
        expect(previousOf(result)).toEqual([{ name: 'Page the SOC', prior: LIVE_RULE }])
      },
    )
  })

  it('always converges the enabled state through its own PATCH, since the body cannot carry it', async () => {
    // The documented create/update schema has no enabled field, so a rule left
    // disabled in the console would stay disabled and page nobody.
    await withFetch(
      [platformJson({ data: [LIVE_RULE] }), platformJson({ data: {} }), platformJson({ data: {} })],
      async (calls) => {
        const result = await deploy(ctx([DECLARED]))

        const status = calls.filter((c) => c.method === 'PATCH')
        expect(status).toHaveLength(1)
        expect(status[0].path).toBe(NOTIFICATION_RULE_ENDPOINTS.statusById(UUID))
        expect(objectBody(status[0])).toEqual({ status: 'enabled' })
        expect(result.success).toBe(true)
      },
    )
  })

  it('disables a rule the canvas explicitly turns off, including the string form', async () => {
    await withFetch(
      [platformJson({ data: [LIVE_RULE] }), platformJson({ data: {} }), platformJson({ data: {} })],
      async (calls) => {
        await deploy(ctx([{ fields: { ...DECLARED.fields, enabled: 'false' } }]))

        expect(objectBody(calls.filter((c) => c.method === 'PATCH')[0])).toEqual({ status: 'disabled' })
      },
    )
  })

  it('makes no status call when the create response carried no uuid to patch', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: {} })], async (calls) => {
      const result = await deploy(ctx([DECLARED]))

      expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
      expect(previousOf(result)[0].createdUuid).toBeUndefined()
      expect(result.success).toBe(true)
    })
  })

  it('builds forward_source from every channel the canvas declares', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: { rule_uuid: UUID } }), platformJson({})], async (calls) => {
      await deploy(
        ctx([
          {
            fields: {
              ...DECLARED.fields,
              email_aggregation: 60,
              email_custom_mail_subject: 'SOC alert',
              slack_channels: ['#soc'],
              syslog_integration_id: 31,
            },
          },
        ]),
      )

      expect(objectBody(calls[1]).forward_source).toEqual({
        email: {
          distribution_list: ['soc@example.com'],
          aggregation: 60,
          custom_mail_subject: 'SOC alert',
        },
        slack: { channels: ['#soc'] },
        syslog: { id: 31 },
      })
    })
  })

  it('fails before writing when the filter is missing', async () => {
    await withFetch([EMPTY_DATA], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, filter: '' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/filter is required/)
      expect(calls).toHaveLength(1)
    })
  })

  it('fails with the parse reason rather than throwing on an invalid filter', async () => {
    await withFetch([EMPTY_DATA], async (calls) => {
      const result = await deploy(ctx([{ fields: { ...DECLARED.fields, filter: '{oops' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Page the SOC/)
      expect(calls).toHaveLength(1)
    })
  })

  it('skips a canvas item with no name', async () => {
    await withFetch([EMPTY_DATA, platformJson({ data: { rule_uuid: UUID } }), platformJson({})], async (calls) => {
      const result = await deploy(ctx([{ fields: { name: '' } }, DECLARED]))

      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
      expect(result.artifacts?.applied).toEqual(['Page the SOC'])
    })
  })

  it('reports the vendor reason when the rule body is rejected', async () => {
    await withFetch([EMPTY_DATA, platformError('unknown forward_type', 422)], async () => {
      const result = await deploy(ctx([DECLARED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Page the SOC/)
      expect(result.message).toMatch(/unknown forward_type/)
      expect(result.artifacts?.applied).toEqual([])
    })
  })

  it('says plainly when the rule applied but its enabled state did not', async () => {
    // "Applied but not enabled" is exactly the silent half-success an operator
    // must be told about — the routing exists and never fires.
    await withFetch(
      [EMPTY_DATA, platformJson({ data: { rule_uuid: UUID } }), platformError('status update refused', 409)],
      async () => {
        const result = await deploy(ctx([DECLARED]))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/applied "Page the SOC" but failed to set its enabled state/)
        expect(result.message).toMatch(/status update refused/)
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
