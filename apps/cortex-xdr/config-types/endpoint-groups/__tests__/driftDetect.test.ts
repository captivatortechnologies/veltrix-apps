import driftDetect from '../driftDetect'
import { ENDPOINT_GROUP_ENDPOINTS } from '../_shared'
import {
  type ItemInput,
  cortexError,
  cortexReply,
  driftContext,
  mentionsApiKey,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'endpoint-groups'
const LIST = ENDPOINT_GROUP_ENDPOINTS.list

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: { name: 'Workstations', description: 'managed by Veltrix', group_type: 'static' },
}

/** The live group, matching what the canvas declares. */
const IN_SYNC = {
  name: 'Workstations',
  description: 'managed by Veltrix',
  group_type: 'static',
}

describe('cortex-xdr endpoint-groups driftDetect handler', () => {
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

  it('reads the live groups once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ groups: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(LIST)
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('flags a field the console changed out from under the canvas', async () => {
    await withFetch(
      [cortexReply({ groups: [{ ...IN_SYNC, description: 'edited in the console' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs).toHaveLength(1)
        expect(result.diffs[0].field).toBe('Workstations.description')
        expect(result.diffs[0].expected).toBe('managed by Veltrix')
        expect(result.diffs[0].actual).toBe('edited in the console')
        expect(result.diffs[0].severity).toBe('warning')
      },
    )
  })

  it('flags a group whose type was switched', async () => {
    await withFetch([cortexReply({ groups: [{ ...IN_SYNC, group_type: 'dynamic' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Workstations.group_type')
      expect(result.diffs[0].actual).toBe('dynamic')
    })
  })

  it('does not treat a case difference as drift', async () => {
    await withFetch([cortexReply({ groups: [{ ...IN_SYNC, group_type: 'STATIC' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('skips a declared group that is not present rather than raising false drift', async () => {
    // A group missing from the live list may simply not be readable on this
    // tenant; claiming drift on it would page an operator for nothing.
    await withFetch([cortexReply({ groups: [] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('does not assert on an optional field the canvas left blank', async () => {
    await withFetch(
      [cortexReply({ groups: [{ name: 'Workstations', description: 'set in console', group_type: 'static' }] })],
      async () => {
        const result = await driftDetect(ctx([{ fields: { name: 'Workstations', description: '' } }]))

        expect(result.hasDrift).toBe(false)
      },
    )
  })

  it('asserts no drift when the live list cannot be read', async () => {
    await withFetch([cortexError('not supported on this tenant', 404)], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      // It stops at the read — no comparison is invented from a failed listing.
      expect(calls).toHaveLength(1)
    })
  })

  it('asserts no drift rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('EAI_AGAIN', async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('keeps the API key out of every diff it reports', async () => {
    await withFetch(
      [cortexReply({ groups: [{ ...IN_SYNC, description: 'changed' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(mentionsApiKey(result.diffs)).toBe(false)
      },
    )
  })
})
