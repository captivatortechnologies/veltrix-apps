import driftDetect from '../driftDetect'
import { EXTERNAL_APPLICATION_BASE } from '../_shared'
import {
  type ItemInput,
  driftContext,
  mentionsApiKey,
  platformError,
  platformJson,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'external-applications'
const BASE = EXTERNAL_APPLICATION_BASE

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

const DECLARED = {
  fields: {
    name: 'SOC webhook',
    application_type: 'webhook',
    description: 'managed by Veltrix',
    connection_config: '{"url":"https://hooks.example/soc"}',
  },
}

const IN_SYNC = {
  application_id: 88,
  name: 'SOC webhook',
  application_type: 'webhook',
  description: 'managed by Veltrix',
  connection_config: { url: 'https://hooks.example/soc' },
}

describe('cortex-xdr external-applications driftDetect handler', () => {
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

  it('lists with a plain GET once and reports no drift when the applications match', async () => {
    await withFetch([platformJson({ data: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(BASE)
      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags an application whose type was changed underneath the same name', async () => {
    await withFetch([platformJson({ data: [{ ...IN_SYNC, application_type: 'aws_s3' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('SOC webhook.application_type')
      expect(result.diffs[0].expected).toBe('webhook')
      expect(result.diffs[0].actual).toBe('aws_s3')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('flags a description edited in the console', async () => {
    await withFetch([platformJson({ data: [{ ...IN_SYNC, description: 'edited' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('SOC webhook.description')
    })
  })

  it('does not diff connection_config, whose secrets providers mask on read', async () => {
    // A masked secret would otherwise read as drift on every single scan.
    await withFetch(
      [platformJson({ data: [{ ...IN_SYNC, connection_config: { url: '***', auth_header: '***' } }] })],
      async () => {
        const result = await driftDetect(ctx([DECLARED]))

        expect(result.hasDrift).toBe(false)
        expect(result.diffs).toHaveLength(0)
      },
    )
  })

  it('skips a declared application that is not present rather than raising false drift', async () => {
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
    await withFetch([platformJson({ data: [{ ...IN_SYNC, description: 'edited' }] })], async () => {
      const result = await driftDetect(ctx([DECLARED]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
