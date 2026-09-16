import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  deployContext,
  mentionsSecret,
  objectBody,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'policies'
const POLICIES = `/policyservice/v1/orgs/${ORG_KEY}/policies`
const SUMMARY = `${POLICIES}/summary`

const POLICY_JSON = '{"av_settings":{"onAccessScan":{"enabled":true}},"rules":[]}'

/** A policy export pasted whole — it carries a foreign id, org key and is_system. */
const PASTED_EXPORT = JSON.stringify({
  id: 999,
  org_key: 'SOMEONE-ELSES-ORG',
  name: 'Exported Standard',
  description: 'exported description',
  priority_level: 'LOW',
  is_system: true,
  av_settings: { onAccessScan: { enabled: false } },
})

const LIVE_SUMMARY = { id: 7, name: 'Standard', description: 'old description', priority_level: 'LOW', is_system: false }
const LIVE_FULL = {
  id: 7,
  org_key: ORG_KEY,
  name: 'Standard',
  description: 'old description',
  priority_level: 'LOW',
  is_system: false,
  av_settings: { onAccessScan: { enabled: false } },
  rules: [{ id: 1, action: 'TERMINATE' }],
}

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function policy(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const STANDARD = policy({ name: 'Standard', description: 'baseline', priorityLevel: 'HIGH', policyJson: POLICY_JSON })

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black policies deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([STANDARD], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([STANDARD], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([STANDARD], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([cbJson({ policies: [] }), cbJson({ id: 4242 })], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(SUMMARY)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a policy that does not exist yet and records it as app-created', async () => {
    await withFetch([cbJson({ policies: [] }), cbJson({ id: 4242 })], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(POLICIES)
      expect(objectBody(posted[0])).toEqual({
        av_settings: { onAccessScan: { enabled: true } },
        rules: [],
        org_key: ORG_KEY,
        name: 'Standard',
        description: 'baseline',
        priority_level: 'HIGH',
        is_system: false,
      })
      // `existed: false` is what tells rollback this policy is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: 'Standard', existed: false, policyId: '4242' },
      ])
    })
  })

  it('strips the pasted export id and forces the managed fields over the pasted body', async () => {
    await withFetch([cbJson({ policies: [] }), cbJson({ id: 4242 })], async (calls) => {
      const result = await deploy(
        ctx([policy({ name: 'Standard', description: 'baseline', priorityLevel: 'HIGH', policyJson: PASTED_EXPORT })]),
      )

      expect(result.success).toBe(true)
      const body = objectBody(writes(calls)[0])
      // An export that kept its own id, org key or name would have this deploy
      // rewrite somebody else's policy.
      expect(body.id).toBeUndefined()
      expect(body.org_key).toBe(ORG_KEY)
      expect(body.name).toBe('Standard')
      expect(body.description).toBe('baseline')
      expect(body.priority_level).toBe('HIGH')
      expect(body.is_system).toBe(false)
      // Everything the managed fields do not own survives verbatim.
      expect(body.av_settings).toEqual({ onAccessScan: { enabled: false } })
    })
  })

  it('drops a policy whose JSON does not parse rather than deploying an empty body', async () => {
    await withFetch([cbJson({ policies: [] })], async (calls) => {
      const result = await deploy(ctx([policy({ name: 'Broken', priorityLevel: 'LOW', policyJson: '{not json' })]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('Deployed 0')
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('deploys the parseable policies alongside one that was dropped', async () => {
    await withFetch([cbJson({ policies: [] }), cbJson({ id: 4242 })], async (calls) => {
      const result = await deploy(
        ctx([policy({ name: 'Broken', priorityLevel: 'LOW', policyJson: '[]' }), STANDARD]),
      )

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(objectBody(posted[0]).name).toBe('Standard')
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('reads the full policy before updating it so the rollback snapshot is the live one', async () => {
    await withFetch([cbJson({ policies: [LIVE_SUMMARY] }), cbJson(LIVE_FULL), cbJson({ id: 7 })], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(3)
      expect(calls[0].path).toBe(SUMMARY)
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe(`${POLICIES}/7`)
      expect(calls[2].method).toBe('PUT')
      expect(calls[2].path).toBe(`${POLICIES}/7`)
      // The PUT carries the live id, not the one pasted into the JSON body.
      expect(objectBody(calls[2]).id).toBe(7)
      expect(objectBody(calls[2]).priority_level).toBe('HIGH')
      expect(objectBody(calls[2]).description).toBe('baseline')

      // The snapshot rollback restores must be the LIVE policy, not the spec's.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: 'Standard', existed: true, policyId: '7', prior: LIVE_FULL },
      ])
    })
  })

  it('records no prior snapshot when the pre-update read is refused', async () => {
    await withFetch(
      [cbJson({ policies: [LIVE_SUMMARY] }), cbError('policy read denied', 403), cbJson({ id: 7 })],
      async () => {
        const result = await deploy(ctx([STANDARD]))

        expect(result.success).toBe(true)
        // An empty snapshot beats a fabricated one — rollback then leaves the
        // adopted policy alone rather than writing a guess over it.
        expect(entries(result)[0].existed).toBe(true)
        expect(entries(result)[0].prior).toBeUndefined()
      },
    )
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([cbJson({ policies: [] }), cbError('policy name already in use', 400)], async () => {
      const result = await deploy(ctx([STANDARD]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('policy name already in use')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list policies/)
      expect(result.message).toContain('forbidden')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('keeps the rollback entry of the policy that succeeded when another fails', async () => {
    await withFetch(
      [cbJson({ policies: [] }), cbError('policy quota exceeded', 400), cbJson({ id: 8 })],
      async () => {
        const result = await deploy(
          ctx([
            policy({ name: 'First', priorityLevel: 'LOW', policyJson: POLICY_JSON }),
            policy({ name: 'Second', priorityLevel: 'LOW', policyJson: POLICY_JSON }),
          ]),
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain('policy quota exceeded')
        // Dropping the successful entry would strand a created policy outside rollback.
        expect(entries(result)).toEqual([
          { itemId: 'item-2', name: 'Second', existed: false, policyId: '8' },
        ])
      },
    )
  })

  it('deletes a policy it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Retired', existed: false, policyId: '55' }]
    await withFetch([cbJson({ policies: [] }), cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${POLICIES}/55`)
    })
  })

  it('never deletes a policy it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'PreExisting', existed: true, policyId: '55' }]
    await withFetch([cbJson({ policies: [] })], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('updates a renamed policy in place instead of deleting it and creating another', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-1', name: 'Old Name', existed: false, policyId: '7' }]
    await withFetch(
      [cbJson({ policies: [{ ...LIVE_SUMMARY, name: 'Old Name' }] }), cbJson(LIVE_FULL), cbJson({ id: 7 })],
      async (calls) => {
        const result = await deploy(
          ctx([policy({ name: 'New Name', description: 'baseline', priorityLevel: 'HIGH', policyJson: POLICY_JSON })], {
            priorEntries: prior,
          }),
        )

        expect(result.success).toBe(true)
        const written = writes(calls)
        expect(written).toHaveLength(1)
        expect(written[0].method).toBe('PUT')
        expect(written[0].path).toBe(`${POLICIES}/7`)
        expect(objectBody(written[0]).name).toBe('New Name')
        expect(entries(result)[0].existed).toBe(true)
      },
    )
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([cbJson({ policies: [] }), cbJson({ id: 4242 })], async () => {
      const result = await deploy(ctx([STANDARD], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbJson({ policies: [] }), cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
