import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  deployContext,
  mentionsSecret,
  objectBody,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'data-forwarders'
const FORWARDERS = `/data_forwarder/v2/orgs/${ORG_KEY}/configs`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function forwarder(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

const SPEC = forwarder({
  name: 'Alerts to S3',
  type: 'alert',
  destination: 'aws_s3',
  enabled: true,
  s3BucketName: 'cb-alerts',
  s3Prefix: 'prod/',
})

/** The same forwarder pointed at a different bucket — a plain PUT update. */
const STALE_LIVE = {
  id: 'fw-1',
  name: 'Alerts to S3',
  type: 'alert',
  destination: 'aws_s3',
  enabled: true,
  s3_bucket_name: 'old-bucket',
  s3_prefix: 'prod/',
}

const IN_SYNC = { ...STALE_LIVE, s3_bucket_name: 'cb-alerts' }

const STALE_SNAPSHOT = {
  name: 'Alerts to S3',
  type: 'alert',
  destination: 'aws_s3',
  enabled: true,
  s3_bucket_name: 'old-bucket',
  s3_prefix: 'prod/',
}

describe('carbon-black data-forwarders deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SPEC], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SPEC], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SPEC], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'fw-new' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(FORWARDERS)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a forwarder that does not exist yet and records it as app-created', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'fw-new' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(FORWARDERS)
      expect(objectBody(posted[0])).toEqual({
        name: 'Alerts to S3',
        type: 'alert',
        destination: 'aws_s3',
        enabled: true,
        s3_bucket_name: 'cb-alerts',
        s3_prefix: 'prod/',
      })
      // `existed: false` is what tells rollback this forwarder is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: 'Alerts to S3', existed: false, id: 'fw-new' },
      ])
    })
  })

  it('sends only the destination-specific fields for an Azure forwarder', async () => {
    const azure = forwarder({
      name: 'Alerts to Azure',
      type: 'alert',
      destination: 'azure_blob_storage',
      enabled: true,
      azureStorageAccount: 'cbstore',
      azureContainerName: 'alerts',
    })
    await withFetch([EMPTY_LIST, cbJson({ id: 'fw-az' })], async (calls) => {
      const result = await deploy(ctx([azure]))

      expect(result.success).toBe(true)
      expect(objectBody(writes(calls)[0])).toEqual({
        name: 'Alerts to Azure',
        type: 'alert',
        destination: 'azure_blob_storage',
        enabled: true,
        azure_storage_account: 'cbstore',
        azure_container_name: 'alerts',
      })
    })
  })

  it('updates a forwarder that already exists and records its prior state, not the desired one', async () => {
    await withFetch([cbJson({ results: [STALE_LIVE] }), cbJson({ id: 'fw-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${FORWARDERS}/fw-1`)
      expect(objectBody(put[0]).s3_bucket_name).toBe('cb-alerts')

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: 'Alerts to S3', existed: true, id: 'fw-1', prior: STALE_SNAPSHOT },
      ])
    })
  })

  it('writes nothing when the live forwarder already equals the spec', async () => {
    await withFetch([cbJson({ results: [IN_SYNC] })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      // Re-PUTting an identical forwarder churns the vendor's config history for
      // no reason; the handler short-circuits on definitionEquals.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: 'Alerts to S3',
          existed: true,
          id: 'fw-1',
          prior: { ...STALE_SNAPSHOT, s3_bucket_name: 'cb-alerts' },
        },
      ])
    })
  })

  it('recreates rather than updates when the immutable event type changes', async () => {
    const retyped = forwarder({
      name: 'Alerts to S3',
      type: 'auditlog',
      destination: 'aws_s3',
      enabled: true,
      s3BucketName: 'cb-alerts',
      s3Prefix: 'prod/',
    })
    await withFetch([cbJson({ results: [IN_SYNC] }), cbJson({}), cbJson({ id: 'fw-2' })], async (calls) => {
      const result = await deploy(ctx([retyped]))

      expect(result.success).toBe(true)
      // `type` cannot be PUT — the vendor only accepts delete + create.
      const changed = writes(calls)
      expect(changed).toHaveLength(2)
      expect(changed[0].method).toBe('DELETE')
      expect(changed[0].path).toBe(`${FORWARDERS}/fw-1`)
      expect(changed[1].method).toBe('POST')
      expect(changed[1].path).toBe(FORWARDERS)
      expect(objectBody(changed[1]).type).toBe('auditlog')
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: 'Alerts to S3',
          existed: true,
          id: 'fw-2',
          prior: { ...STALE_SNAPSHOT, s3_bucket_name: 'cb-alerts' },
        },
      ])
    })
  })

  it('keeps the original pre-management snapshot when a destination change forces a recreate', async () => {
    const original = {
      name: 'Alerts to S3',
      type: 'alert',
      destination: 'gcs_bucket',
      enabled: true,
      gcs_bucket_name: 'legacy-gcs',
    }
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', name: 'Alerts to S3', existed: true, id: 'fw-1', prior: original },
    ]
    const moved = forwarder({
      name: 'Alerts to S3',
      type: 'alert',
      destination: 'azure_blob_storage',
      enabled: true,
      azureStorageAccount: 'cbstore',
      azureContainerName: 'alerts',
    })
    await withFetch([cbJson({ results: [IN_SYNC] }), cbJson({}), cbJson({ id: 'fw-2' })], async (calls) => {
      const result = await deploy(ctx([moved], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(2)
      expect(objectBody(writes(calls)[1]).destination).toBe('azure_blob_storage')
      // The delete+recreate must not overwrite the only copy of the customer's
      // own forwarder with the state this app just replaced.
      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].prior).toEqual(original)
      expect(entries(result)[0].existed).toBe(true)
      expect(entries(result)[0].id).toBe('fw-2')
    })
  })

  it('abandons the recreate when the vendor refuses the delete', async () => {
    const retyped = forwarder({
      name: 'Alerts to S3',
      type: 'auditlog',
      destination: 'aws_s3',
      enabled: true,
      s3BucketName: 'cb-alerts',
    })
    await withFetch([cbJson({ results: [IN_SYNC] }), cbError('forwarder is locked', 409)], async (calls) => {
      const result = await deploy(ctx([retyped]))

      // Posting the replacement anyway would leave two forwarders shipping the
      // same events.
      expect(result.success).toBe(false)
      expect(result.message).toContain('forwarder is locked')
      expect(writes(calls)).toHaveLength(1)
      expect(entries(result)).toEqual([])
    })
  })

  it('treats a 404 on the recreate delete as already gone and still creates the replacement', async () => {
    const retyped = forwarder({
      name: 'Alerts to S3',
      type: 'auditlog',
      destination: 'aws_s3',
      enabled: true,
      s3BucketName: 'cb-alerts',
    })
    await withFetch([cbJson({ results: [IN_SYNC] }), cbNotFound(), cbJson({ id: 'fw-2' })], async (calls) => {
      const result = await deploy(ctx([retyped]))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(2)
      expect(writes(calls)[1].method).toBe('POST')
      expect(entries(result)[0].id).toBe('fw-2')
    })
  })

  it('matches the live forwarder when the listing comes back as a bare array', async () => {
    await withFetch([cbJson([STALE_LIVE]), cbJson({ id: 'fw-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      expect(writes(calls)[0].method).toBe('PUT')
      expect(writes(calls)[0].path).toBe(`${FORWARDERS}/fw-1`)
    })
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([EMPTY_LIST, cbError('bucket is not writable by Carbon Black', 400)], async () => {
      const result = await deploy(ctx([SPEC]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('bucket is not writable by Carbon Black')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list data forwarders/)
      expect(result.message).toContain('forbidden')
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deletes a forwarder it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Retired', existed: false, id: 'fw-old' }]
    await withFetch([EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${FORWARDERS}/fw-old`)
    })
  })

  it('never deletes a forwarder it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'PreExisting', existed: true, id: 'fw-them' }]
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'fw-new' })], async () => {
      const result = await deploy(ctx([SPEC], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([EMPTY_LIST, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
