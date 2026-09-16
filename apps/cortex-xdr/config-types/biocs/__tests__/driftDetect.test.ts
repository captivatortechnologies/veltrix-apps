import driftDetect from '../driftDetect'
import { BIOC_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'biocs'
const GET = BIOC_ENDPOINTS.get

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: {
    name: 'LSASS handle access',
    type: 'CREDENTIAL_ACCESS',
    severity: 'SEV_040_HIGH',
    status: 'enabled',
  },
}

const IN_SYNC = {
  rule_id: 4210,
  name: 'LSASS handle access',
  type: 'CREDENTIAL_ACCESS',
  severity: 'SEV_040_HIGH',
  status: 'enabled',
}

describe('cortex-xdr biocs driftDetect handler', () => {
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

  it('flags a detection someone disabled in the console', async () => {
    // A BIOC switched to disabled stops detecting entirely — the single most
    // consequential silent change this config type can suffer.
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, status: 'disabled' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('LSASS handle access.status')
      expect(result.diffs[0].expected).toBe('enabled')
      expect(result.diffs[0].actual).toBe('disabled')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('flags a severity that was lowered', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, severity: 'SEV_010_INFO' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.diffs[0].field).toBe('LSASS handle access.severity')
      expect(result.diffs[0].actual).toBe('SEV_010_INFO')
    })
  })

  it('does not treat a case difference as drift', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, status: 'ENABLED' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
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
    await withFetch([cortexError('bioc API not licensed', 403)], async (calls) => {
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
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, status: 'disabled' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
