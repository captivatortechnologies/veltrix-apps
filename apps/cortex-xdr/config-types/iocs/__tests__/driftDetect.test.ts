import driftDetect from '../driftDetect'
import { IOC_ENDPOINTS } from '../_shared'
import {
  type ItemInput,
  cortexError,
  cortexReply,
  driftContext,
  mentionsApiKey,
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'iocs'
const GET_CHANGES = IOC_ENDPOINTS.getChanges

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const BAD_IP = '203.0.113.7'

const DECLARED = {
  fields: {
    indicator: BAD_IP,
    type: 'IP',
    severity: 'CRITICAL',
    reputation: 'BAD',
    reliability: 'A',
  },
}

const IN_SYNC = {
  indicator: BAD_IP,
  type: 'IP',
  severity: 'CRITICAL',
  reputation: 'BAD',
  reliability: 'A',
}

describe('cortex-xdr iocs driftDetect handler', () => {
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

  it('reads the live indicators from epoch 0 once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ indicators: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(GET_CHANGES)
      expect(requestData(calls[0])).toEqual({ ts: 0 })
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags an indicator whose severity was lowered in the console', async () => {
    // A CRITICAL indicator quietly downgraded to LOW stops raising the alerts
    // the operator believes it raises.
    await withFetch([cortexReply({ indicators: [{ ...IN_SYNC, severity: 'LOW' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe(`${BAD_IP}.severity`)
      expect(result.diffs[0].expected).toBe('CRITICAL')
      expect(result.diffs[0].actual).toBe('LOW')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('reports every changed field of one indicator', async () => {
    await withFetch(
      [cortexReply({ indicators: [{ ...IN_SYNC, reputation: 'GOOD', reliability: 'F' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.diffs).toHaveLength(2)
        expect(result.diffs[0].field).toBe(`${BAD_IP}.reputation`)
        expect(result.diffs[1].field).toBe(`${BAD_IP}.reliability`)
      },
    )
  })

  it('does not treat a case difference as drift', async () => {
    await withFetch([cortexReply({ indicators: [{ ...IN_SYNC, severity: 'critical' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('skips a declared indicator that is not present rather than raising false drift', async () => {
    await withFetch([cortexReply({ indicators: [] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('does not assert on an optional field the canvas left blank', async () => {
    await withFetch([cortexReply([{ indicator: BAD_IP, type: 'IP', reputation: 'GOOD' }])], async () => {
      const result = await driftDetect(ctx([{ fields: { indicator: BAD_IP, type: 'IP' } }]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('asserts no drift when the live list cannot be read', async () => {
    await withFetch([cortexError('get_changes unavailable', 403)], async (calls) => {
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
    await withFetch([cortexReply({ indicators: [{ ...IN_SYNC, severity: 'LOW' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
