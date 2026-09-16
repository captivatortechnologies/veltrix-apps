import driftDetect from '../driftDetect'
import { PREVENTION_PROFILE_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'prevention-profiles'
const GET = PREVENTION_PROFILE_ENDPOINTS.get

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const MODULES = '{"anti_ransomware":{"action":"block"}}'

const DECLARED = {
  fields: { name: 'Servers hardened', description: 'managed by Veltrix', modules: MODULES },
}

const IN_SYNC = {
  id: 55,
  name: 'Servers hardened',
  description: 'managed by Veltrix',
  modules: { anti_ransomware: { action: 'block' } },
}

describe('cortex-xdr prevention-profiles driftDetect handler', () => {
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

  it('reads the live profiles once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ profiles: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(GET)
      expect(requestData(calls[0])).toEqual({ type: 'prevention' })
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags a protection module downgraded from block to report', async () => {
    // This is the failure this whole app exists to catch: the endpoint is no
    // longer protected the way the canvas says it is.
    await withFetch(
      [cortexReply({ profiles: [{ ...IN_SYNC, modules: { anti_ransomware: { action: 'report' } } }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs[0].field).toBe('Servers hardened.modules')
        expect(result.diffs[0].expected).toEqual({ anti_ransomware: { action: 'block' } })
        expect(result.diffs[0].actual).toEqual({ anti_ransomware: { action: 'report' } })
        expect(result.diffs[0].severity).toBe('warning')
      },
    )
  })

  it('flags a profile whose modules were cleared entirely', async () => {
    await withFetch([cortexReply({ profiles: [{ ...IN_SYNC, modules: {} }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Servers hardened.modules')
      expect(result.diffs[0].actual).toEqual({})
    })
  })

  it('flags a description edited in the console', async () => {
    await withFetch([cortexReply({ profiles: [{ ...IN_SYNC, description: 'edited' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Servers hardened.description')
    })
  })

  it('skips a declared profile that is not present rather than raising false drift', async () => {
    await withFetch([cortexReply([])], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('leaves an unparseable modules blob to validate rather than reporting it as drift', async () => {
    await withFetch([cortexReply([IN_SYNC])], async () => {
      const result = await driftDetect(ctx([{ fields: { ...DECLARED.fields, modules: '{oops' } }]))

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
    await withFetch([cortexReply({ profiles: [{ ...IN_SYNC, description: 'edited' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
