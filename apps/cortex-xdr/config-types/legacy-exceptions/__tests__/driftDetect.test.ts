import driftDetect from '../driftDetect'
import { LEGACY_EXCEPTION_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'legacy-exceptions'
const FETCH = LEGACY_EXCEPTION_ENDPOINTS.fetch

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: {
    name: 'Allow backup agent',
    platform: 'windows',
    module: 12,
    status: 'enabled',
    scope: 'global',
  },
}

const IN_SYNC = {
  id: 'exc-3311',
  rule_name: 'Allow backup agent',
  platform: 'windows',
  module: 12,
  status: 'enabled',
  scope: 'global',
}

describe('cortex-xdr legacy-exceptions driftDetect handler', () => {
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

  it('fetches the live exceptions once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ DATA: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(FETCH)
      expect(requestData(calls[0])).toEqual({ search_from: 0, search_to: 1000 })
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags an exception someone switched off', async () => {
    await withFetch([cortexReply({ DATA: [{ ...IN_SYNC, status: 'disabled' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Allow backup agent.status')
      expect(result.diffs[0].expected).toBe('enabled')
      expect(result.diffs[0].actual).toBe('disabled')
    })
  })

  it('flags an exception moved to a different protection module', async () => {
    // The module decides WHICH protection the exception disables — the wrong one
    // leaves the intended protection bypassed and another one weakened.
    await withFetch([cortexReply({ DATA: [{ ...IN_SYNC, module: 30 }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Allow backup agent.module')
      expect(result.diffs[0].expected).toBe(12)
      expect(result.diffs[0].actual).toBe(30)
    })
  })

  it('flags an exception widened from a profile scope to global', async () => {
    await withFetch([cortexReply({ DATA: [{ ...IN_SYNC, scope: 'profile' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Allow backup agent.scope')
    })
  })

  it('does not treat a case difference as drift', async () => {
    await withFetch([cortexReply({ DATA: [{ ...IN_SYNC, platform: 'WINDOWS' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('skips a declared exception that is not present rather than raising false drift', async () => {
    await withFetch([cortexReply({ DATA: [] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('asserts no drift when the live list cannot be read', async () => {
    await withFetch([cortexError('not permitted for this key', 403)], async (calls) => {
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
    await withFetch([cortexReply({ DATA: [{ ...IN_SYNC, status: 'disabled' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
