import driftDetect from '../driftDetect'
import { SYSLOG_ENDPOINTS } from '../_shared'
import {
  type ItemInput,
  cortexError,
  cortexReply,
  driftContext,
  mentionsApiKey,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'syslog-integrations'
const GET = SYSLOG_ENDPOINTS.get

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: {
    name: 'SOC collector',
    address: 'collector.internal',
    port: 6514,
    protocol: 'TLS',
    facility: 'LOCAL7',
  },
}

const IN_SYNC = {
  SYSLOG_INTEGRATION_ID: 31,
  SYSLOG_INTEGRATION_NAME: 'SOC collector',
  SYSLOG_INTEGRATION_ADDRESS: 'collector.internal',
  SYSLOG_INTEGRATION_PORT: 6514,
  SYSLOG_INTEGRATION_PROTOCOL: 'TLS',
  FACILITY: 'LOCAL7',
}

describe('cortex-xdr syslog-integrations driftDetect handler', () => {
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

  it('reads the live integrations once and reports no drift when they match', async () => {
    await withFetch([cortexReply({ objects: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(GET)
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags a destination address that was repointed', async () => {
    // A repointed collector means alerts are still "forwarded" — somewhere else.
    await withFetch(
      [cortexReply({ objects: [{ ...IN_SYNC, SYSLOG_INTEGRATION_ADDRESS: 'attacker.example' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs[0].field).toBe('SOC collector.address')
        expect(result.diffs[0].expected).toBe('collector.internal')
        expect(result.diffs[0].actual).toBe('attacker.example')
      },
    )
  })

  it('flags a port change', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, SYSLOG_INTEGRATION_PORT: 514 }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('SOC collector.port')
      expect(result.diffs[0].expected).toBe(6514)
      expect(result.diffs[0].actual).toBe(514)
    })
  })

  it('flags a transport downgraded from TLS to plain UDP', async () => {
    await withFetch(
      [cortexReply({ objects: [{ ...IN_SYNC, SYSLOG_INTEGRATION_PROTOCOL: 'UDP' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs[0].field).toBe('SOC collector.protocol')
        expect(result.diffs[0].actual).toBe('UDP')
      },
    )
  })

  it('does not treat a protocol case difference as drift', async () => {
    await withFetch(
      [cortexReply({ objects: [{ ...IN_SYNC, SYSLOG_INTEGRATION_PROTOCOL: 'tls' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(false)
      },
    )
  })

  it('flags a changed facility', async () => {
    await withFetch([cortexReply({ objects: [{ ...IN_SYNC, FACILITY: 'LOCAL0' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('SOC collector.facility')
    })
  })

  it('skips a declared integration that is not present rather than raising false drift', async () => {
    await withFetch([cortexReply({ objects: [] })], async () => {
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
    await withFetch(
      [cortexReply({ objects: [{ ...IN_SYNC, SYSLOG_INTEGRATION_ADDRESS: 'elsewhere' }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(true)
        expect(mentionsApiKey(result.diffs)).toBe(false)
      },
    )
  })
})
