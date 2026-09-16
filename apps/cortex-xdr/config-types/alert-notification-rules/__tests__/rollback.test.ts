import rollback from '../rollback'
import { NOTIFICATION_RULE_ENDPOINTS } from '../_shared'
import {
  NO_CONTENT,
  mentionsApiKey,
  objectBody,
  platformError,
  platformJson,
  rollbackContext,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'alert-notification-rules'
const UUID = '7f1c-uuid'
const CREATED_UUID = 'new-uuid'

const LIVE_RULE = {
  rule_uuid: UUID,
  name: 'Page the SOC',
  description: 'set by the previous owner',
  forward_type: 'alert',
  filter: { severity: ['critical'] },
  forward_source: { email: { distribution_list: ['oncall@example.com'] } },
  time_zone: 'America/New_York',
  mail_format: 'issue',
  enabled: false,
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  {
    fields: {
      name: 'Page the SOC',
      description: 'managed by Veltrix',
      time_zone: 'UTC',
      email_distribution_list: ['soc@example.com'],
    },
  },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr alert-notification-rules rollback handler', () => {
  it('does nothing when the deploy recorded no prior state', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ previous: [] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Nothing to roll back/)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing when there is no rollback data at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses without a credential instead of calling the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Page the SOC', prior: LIVE_RULE }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior rule body by PUT to its uuid path, not the canvas values', async () => {
    await withFetch([platformJson({ data: {} }), platformJson({ data: {} })], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'Page the SOC', prior: LIVE_RULE }] }))

      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(NOTIFICATION_RULE_ENDPOINTS.ruleById(UUID))
      expect(objectBody(calls[0])).toEqual({
        name: 'Page the SOC',
        description: 'set by the previous owner',
        forward_type: 'alert',
        filter: { severity: ['critical'] },
        // The recipients the tenant really had, not the ones the canvas wanted.
        forward_source: { email: { distribution_list: ['oncall@example.com'] } },
        time_zone: 'America/New_York',
        mail_format: 'issue',
      })
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('restores the prior enabled state too, through its own PATCH', async () => {
    // The body cannot carry `enabled`, so a restore that skipped this would put
    // a rule back but leave it firing when it had been switched off.
    await withFetch([platformJson({ data: {} }), platformJson({ data: {} })], async (calls) => {
      await rollback(ctx({ previous: [{ name: 'Page the SOC', prior: LIVE_RULE }] }))

      expect(calls[1].method).toBe('PATCH')
      expect(calls[1].path).toBe(NOTIFICATION_RULE_ENDPOINTS.statusById(UUID))
      expect(objectBody(calls[1])).toEqual({ status: 'disabled' })
    })
  })

  it('restores an enabled rule as enabled', async () => {
    await withFetch([platformJson({ data: {} }), platformJson({ data: {} })], async (calls) => {
      await rollback(
        ctx({ previous: [{ name: 'Page the SOC', prior: { ...LIVE_RULE, enabled: true } }] }),
      )

      expect(objectBody(calls[1])).toEqual({ status: 'enabled' })
    })
  })

  it('deletes a created rule by the uuid the deploy captured', async () => {
    await withFetch([NO_CONTENT], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New rule', prior: null, createdUuid: CREATED_UUID }] }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(NOTIFICATION_RULE_ENDPOINTS.ruleById(CREATED_UUID))
      expect(result.message).toMatch(/0 restored, 1 deleted/)
    })
  })

  it('reports, rather than guesses at, a rule whose created uuid was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'New rule', prior: null }] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/1 newly-created rule\(s\) could not be auto-deleted/)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch(
      [platformJson({ data: {} }), platformJson({ data: {} }), NO_CONTENT],
      async (calls) => {
        const result = await rollback(
          ctx({
            previous: [
              { name: 'New rule', prior: null, createdUuid: CREATED_UUID },
              { name: 'Page the SOC', prior: LIVE_RULE },
            ],
          }),
        )

        expect(calls[0].method).toBe('PUT')
        expect(calls[2].method).toBe('DELETE')
        expect(result.message).toMatch(/1 restored, 1 deleted/)
      },
    )
  })

  it('reports the vendor reason when a restore is rejected, and does not go on to delete', async () => {
    await withFetch([platformError('rule not found', 404)], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'Page the SOC', prior: LIVE_RULE },
            { name: 'New rule', prior: null, createdUuid: CREATED_UUID },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    })
  })

  it('says plainly when the body was restored but its enabled state was not', async () => {
    await withFetch(
      [platformJson({ data: {} }), platformError('status update refused', 409)],
      async () => {
        const result = await rollback(ctx({ previous: [{ name: 'Page the SOC', prior: LIVE_RULE }] }))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/failed to restore enabled state/)
      },
    )
  })

  it('reports the vendor reason when a delete is rejected', async () => {
    await withFetch([platformError('rule is locked', 409)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New rule', prior: null, createdUuid: CREATED_UUID }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New rule', prior: null, createdUuid: CREATED_UUID }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([platformError('forbidden', 403)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'Page the SOC', prior: LIVE_RULE }] }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
