import rollback from '../rollback'
import type { RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  mentionsSecret,
  objectBody,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'data-forwarders'
const FORWARDERS = `/data_forwarder/v2/orgs/${ORG_KEY}/configs`

/** The forwarder as it stood before this app managed it. */
const PRIOR = {
  name: 'Alerts to S3',
  type: 'alert',
  destination: 'gcs_bucket',
  enabled: true,
  gcs_bucket_name: 'legacy-gcs',
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black data-forwarders rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([{ name: 'Alerts to S3', existed: false, id: 'fw-1' }], { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([{ name: 'Alerts to S3', existed: false, id: 'fw-1' }], { settings: NO_ORG_KEY_SETTINGS }),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a forwarder the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: false, id: 'fw-new' }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${FORWARDERS}/fw-new`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores an adopted forwarder by recreating its exact prior body', async () => {
    await withFetch([cbJson({}), cbJson({ id: 'fw-3' })], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: true, id: 'fw-1', prior: PRIOR }]))

      // type and destination are immutable, so a restore is delete + recreate.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${FORWARDERS}/fw-1`)
      expect(calls[1].method).toBe('POST')
      expect(calls[1].path).toBe(FORWARDERS)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(objectBody(calls[1])).toEqual(PRIOR)
      expect(result.message).toContain('1 restored')
    })
  })

  it('recreates without a delete when the deploy never recorded an id', async () => {
    await withFetch([cbJson({ id: 'fw-3' })], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: true, prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('POST')
      expect(result.message).toContain('1 restored')
    })
  })

  it('does nothing when there is no rollback state at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing for an empty entry list', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips an entry whose forwarder id was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: false }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted forwarder untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: true, id: 'fw-1' }]))

      // Deleting it with nothing to recreate would silently stop the customer's
      // own event forwarding.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted forwarder as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: false, id: 'fw-gone' }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('still recreates the original when the forwarder it replaces is already gone', async () => {
    await withFetch([cbNotFound(), cbJson({ id: 'fw-3' })], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: true, id: 'fw-gone', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[1].method).toBe('POST')
      expect(result.message).toContain('1 restored')
    })
  })

  it('does not recreate when the vendor refuses to delete the managed forwarder', async () => {
    await withFetch([cbError('forwarder is locked', 409)], async (calls) => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: true, id: 'fw-1', prior: PRIOR }]))

      // Recreating over a forwarder that is still there would duplicate the feed.
      expect(result.success).toBe(false)
      expect(result.message).toContain('forwarder is locked')
      expect(calls).toHaveLength(1)
    })
  })

  it('reports failure rather than throwing when the vendor rejects the recreate', async () => {
    await withFetch([cbJson({}), cbError('gcs bucket no longer exists', 400)], async () => {
      const result = await rollback(ctx([{ name: 'Alerts to S3', existed: true, id: 'fw-1', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('gcs bucket no longer exists')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          { name: 'First', existed: false, id: 'fw-1' },
          { name: 'Second', existed: false, id: 'fw-2' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${FORWARDERS}/fw-2`)
    })
  })
})
