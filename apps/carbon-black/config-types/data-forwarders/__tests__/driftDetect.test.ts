import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'data-forwarders'
const FORWARDERS = `/data_forwarder/v2/orgs/${ORG_KEY}/configs`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function forwarder(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const DEPLOYED = forwarder({
  name: 'Alerts to S3',
  type: 'alert',
  destination: 'aws_s3',
  enabled: true,
  s3BucketName: 'cb-alerts',
  s3Prefix: 'prod/',
})

const IN_SYNC = {
  id: 'fw-1',
  name: 'Alerts to S3',
  type: 'alert',
  destination: 'aws_s3',
  enabled: true,
  s3_bucket_name: 'cb-alerts',
  s3_prefix: 'prod/',
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black data-forwarders driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live forwarder matches what was deployed', async () => {
    await withFetch([cbJson({ results: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(FORWARDERS)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted forwarder as critical — the event stream is no longer shipping', async () => {
    await withFetch([EMPTY_LIST], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Alerts to S3')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags a forwarder disabled out of band', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Alerts to S3.enabled')!
      expect(diff.expected).toBe(true)
      expect(diff.actual).toBe(false)
      expect(diff.severity).toBe('warning')
    })
  })

  it('treats a forwarder with no enabled flag as enabled', async () => {
    const live = { ...IN_SYNC }
    delete (live as { enabled?: boolean }).enabled
    await withFetch([cbJson({ results: [live] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('flags the immutable event type having been changed', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, type: 'auditlog' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Alerts to S3.type')!
      expect(diff.expected).toBe('alert')
      expect(diff.actual).toBe('auditlog')
    })
  })

  it('flags the forwarder having been repointed at another cloud destination', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, destination: 'gcs_bucket' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Alerts to S3.destination')!
      expect(diff.expected).toBe('aws_s3')
      expect(diff.actual).toBe('gcs_bucket')
    })
  })

  it('flags a forwarder both retyped and disabled', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, type: 'endpoint.event', enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(fields(result)).toContain('Alerts to S3.type')
      expect(fields(result)).toContain('Alerts to S3.enabled')
    })
  })

  it('reads a listing that arrives as a bare array', async () => {
    await withFetch([cbJson([{ ...IN_SYNC, enabled: false }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(fields(result)).toContain('Alerts to S3.enabled')
    })
  })

  it('matches the live forwarder by name case-insensitively', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, name: 'ALERTS TO S3' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('reports no drift when the vendor listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })
})
