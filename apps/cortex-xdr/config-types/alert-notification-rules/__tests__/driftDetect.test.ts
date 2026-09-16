import driftDetect from '../driftDetect'
import { NOTIFICATION_RULE_ENDPOINTS } from '../_shared'
import {
  type ItemInput,
  driftContext,
  mentionsApiKey,
  platformError,
  platformJson,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'alert-notification-rules'
const LIST = NOTIFICATION_RULE_ENDPOINTS.list

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: { name: 'Page the SOC', forward_type: 'alert', time_zone: 'UTC' },
}

const IN_SYNC = {
  rule_uuid: '7f1c-uuid',
  name: 'Page the SOC',
  forward_type: 'alert',
  time_zone: 'UTC',
  enabled: true,
}

describe('cortex-xdr alert-notification-rules driftDetect handler', () => {
  it('asserts no drift and makes no call when there is no credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DECLARED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('asserts no drift and makes no call when the connection has no tenant FQDN', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DECLARED], { noHostname: true }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('lists with a plain GET once and reports no drift when the rules match', async () => {
    await withFetch([platformJson({ data: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(LIST)
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags a notification rule someone switched off', async () => {
    // A disabled routing rule means an alert fires and nobody is told.
    await withFetch([platformJson({ data: [{ ...IN_SYNC, enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Page the SOC.enabled')
      expect(result.diffs[0].expected).toBe(true)
      expect(result.diffs[0].actual).toBe(false)
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('flags a changed forward type', async () => {
    await withFetch([platformJson({ data: [{ ...IN_SYNC, forward_type: 'issue' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Page the SOC.forward_type')
      expect(result.diffs[0].actual).toBe('issue')
    })
  })

  it('flags a changed time zone, which shifts every scheduled digest', async () => {
    await withFetch([platformJson({ data: [{ ...IN_SYNC, time_zone: 'Asia/Tokyo' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Page the SOC.time_zone')
      expect(result.diffs[0].expected).toBe('UTC')
      expect(result.diffs[0].actual).toBe('Asia/Tokyo')
    })
  })

  it('treats a blank time zone on both sides as UTC rather than as drift', async () => {
    await withFetch([platformJson({ data: [{ ...IN_SYNC, time_zone: '' }] })], async () => {
      const result = await driftDetect(
        ctx([{ fields: { name: 'Page the SOC', forward_type: 'alert' } }]),
      )

      expect(result.hasDrift).toBe(false)
    })
  })

  it('treats a rule with no enabled field as enabled, matching the deploy default', async () => {
    const { enabled: _dropped, ...noFlag } = IN_SYNC
    await withFetch([platformJson({ data: [noFlag] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('skips a declared rule that is not present rather than raising false drift', async () => {
    await withFetch([platformJson({ data: [] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('asserts no drift when the live list cannot be read', async () => {
    await withFetch([platformError('not permitted for this key', 403)], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('asserts no drift rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('EAI_AGAIN', async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('keeps the API key out of every diff it reports', async () => {
    await withFetch([platformJson({ data: [{ ...IN_SYNC, enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
