import driftDetect from '../driftDetect'
import { CORRELATION_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'correlation-rules'
const GET = CORRELATION_ENDPOINTS.get

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const XQL = 'dataset = xdr_data | filter action_process_image_name = "mimikatz.exe"'

const DECLARED = {
  fields: {
    name: 'Credential dumping',
    severity: 'SEV_040_HIGH',
    xql_query: XQL,
    execution_mode: 'REAL_TIME',
  },
}

const IN_SYNC = {
  rule_id: 909,
  name: 'Credential dumping',
  severity: 'SEV_040_HIGH',
  xql_query: XQL,
  execution_mode: 'REAL_TIME',
  is_enabled: true,
}

describe('cortex-xdr correlation-rules driftDetect handler', () => {
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

  it('reads the live rules once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ objects: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(GET)
      expect(requestData(calls[0])).toEqual({ search_from: 0, search_to: 1000 })
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags an XQL query that was rewritten in the console', async () => {
    // The query IS the detection: a rewritten one can silently match nothing.
    await withFetch(
      [cortexReply({ objects: [{ ...IN_SYNC, xql_query: 'dataset = xdr_data | filter false' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs[0].field).toBe('Credential dumping.xql_query')
        expect(result.diffs[0].expected).toBe(XQL)
        expect(result.diffs[0].actual).toBe('dataset = xdr_data | filter false')
      },
    )
  })

  it('compares the XQL query exactly, since case is meaningful inside a query', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, xql_query: XQL.toUpperCase() }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Credential dumping.xql_query')
    })
  })

  it('flags a rule that was switched off', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, is_enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Credential dumping.is_enabled')
      expect(result.diffs[0].expected).toBe(true)
      expect(result.diffs[0].actual).toBe(false)
    })
  })

  it('flags an execution mode that fell back to SCHEDULED', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, execution_mode: 'SCHEDULED' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Credential dumping.execution_mode')
      expect(result.diffs[0].actual).toBe('SCHEDULED')
    })
  })

  it('asserts the SCHEDULED default even when the canvas left the mode blank', async () => {
    // Blank means SCHEDULED at deploy time, so drift must hold the same default
    // rather than treating the field as unmanaged.
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, execution_mode: 'REAL_TIME' }] })], async () => {
      const result = await driftDetect(
        ctx([{ fields: { name: 'Credential dumping', xql_query: XQL, severity: 'SEV_040_HIGH' } }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Credential dumping.execution_mode')
      expect(result.diffs[0].expected).toBe('SCHEDULED')
    })
  })

  it('skips a declared rule that is not present rather than raising false drift', async () => {
    await withFetch([cortexReply({ objects: [] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('asserts no drift when the live list cannot be read', async () => {
    await withFetch([cortexError('correlations API not licensed', 403)], async (calls) => {
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
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, is_enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
