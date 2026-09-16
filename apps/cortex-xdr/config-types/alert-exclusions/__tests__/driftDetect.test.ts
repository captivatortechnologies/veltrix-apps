import driftDetect from '../driftDetect'
import { ALERT_EXCLUSION_ENDPOINTS } from '../_shared'
import {
  type ItemInput,
  cortexError,
  cortexReply,
  driftContext,
  mentionsApiKey,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'alert-exclusions'
const LIST = ALERT_EXCLUSION_ENDPOINTS.list

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: { name: 'Suppress backup agent', comment: 'managed by Veltrix', disabled: false },
}

const IN_SYNC = { name: 'Suppress backup agent', comment: 'managed by Veltrix', disabled: false }

describe('cortex-xdr alert-exclusions driftDetect handler', () => {
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

  it('reads the live exclusions once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ exclusions: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(LIST)
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags an exclusion someone silently disabled in the console', async () => {
    // A suppression rule flipped to disabled changes what alerts an analyst sees.
    await withFetch([cortexReply({ exclusions: [{ ...IN_SYNC, disabled: true }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Suppress backup agent.disabled')
      expect(result.diffs[0].expected).toBe('false')
      expect(result.diffs[0].actual).toBe('true')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('flags a comment edited in the console', async () => {
    await withFetch(
      [cortexReply({ exclusions: [{ ...IN_SYNC, comment: 'edited by hand' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs[0].field).toBe('Suppress backup agent.comment')
        expect(result.diffs[0].actual).toBe('edited by hand')
      },
    )
  })

  it('skips a declared exclusion that is not present rather than raising false drift', async () => {
    await withFetch([cortexReply({ exclusions: [] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('asserts no drift when the (undocumented) list endpoint cannot be read', async () => {
    await withFetch([cortexError('no such endpoint', 404)], async (calls) => {
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
    await withFetch([cortexReply({ exclusions: [{ ...IN_SYNC, comment: 'changed' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
