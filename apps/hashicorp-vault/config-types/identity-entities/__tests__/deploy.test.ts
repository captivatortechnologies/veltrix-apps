import deploy, { type EntityRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function canvasWith(entities: Array<Record<string, unknown>>) {
  return makeCanvas(
    entities.map((fields, i) => ({ name: `Entity ${i + 1}`, fields })),
    'identity-entities',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): EntityRollbackEntry[] {
  return (result.rollbackData as { previousState?: EntityRollbackEntry[] })?.previousState ?? []
}

function createdNames(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdNames?: string[] })?.createdNames ?? []
}

const LIVE_ENTITY = {
  data: {
    id: '8d4b0f0e-1a2b-4c3d-9e8f-000000000001',
    name: 'app-svc',
    policies: ['read-only'],
    metadata: { team: 'platform' },
    disabled: true,
    aliases: [{ id: 'alias-1' }],
    group_ids: ['grp-1'],
    creation_time: '2024-01-01T00:00:00Z',
  },
}

describe('Vault Identity Entities Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'app-svc' }]), { token: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-svc' }]), { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-svc' }])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      for (const call of fetchStub.calls) {
        expect(call.headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      }
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('looks the entity up by name and creates it when the lookup 404s', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: 'app-svc', policies: ['app-read', 'ops'], metadataJson: '{"team":"platform"}' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [lookup, write] = fetchStub.calls
      expect(lookup.method).toBe('GET')
      expect(lookup.url).toBe(`${VAULT_BASE}/identity/entity/name/app-svc`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/identity/entity/name/app-svc`)
      expect(JSON.parse(write.body)).toEqual({
        policies: ['app-read', 'ops'],
        metadata: { team: 'platform' },
        disabled: false,
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].prior).toBeUndefined()
      expect(createdNames(result)).toEqual(['app-svc'])
    } finally {
      fetchStub.restore()
    }
  })

  it('updates the entity the lookup found and captures its prior authored state verbatim', async () => {
    const fetchStub = recordFetch([{ status: 200, body: LIVE_ENTITY }, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'app-svc', policies: ['app-read'] }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/entity/name/app-svc`)

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].prior).toEqual({
        policies: ['read-only'],
        metadata: { team: 'platform' },
        disabled: true,
      })
      expect(createdNames(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('writes only the authored fields — the server-computed id, aliases and group_ids are never sent', async () => {
    const fetchStub = recordFetch([{ status: 200, body: LIVE_ENTITY }, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ name: 'app-svc' }])))

      const body = JSON.parse(fetchStub.calls[1].body)
      expect(Object.keys(body)).toEqual(['policies', 'metadata', 'disabled'])
      expect(fetchStub.calls[1].body.includes('aliases')).toBe(false)
      expect(fetchStub.calls[1].body.includes('group_ids')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('always sends policies and metadata so clearing them on the canvas converges the entity', async () => {
    const fetchStub = recordFetch([{ status: 200, body: LIVE_ENTITY }, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ name: 'app-svc' }])))

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        policies: [],
        metadata: {},
        disabled: false,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('coerces metadata values to strings — Vault entity metadata is map[string]string', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(canvasWith([{ name: 'app-svc', metadataJson: '{"team":"platform","tier":1}' }])),
      )

      expect(JSON.parse(fetchStub.calls[1].body).metadata).toEqual({ team: 'platform', tier: '1' })
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-svc' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to create identity entity "app-svc"/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the name lookup errors', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-svc' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read identity entity "app-svc"/)
      expect(result.message).toMatch(/internal error/)
      expect((result.artifacts as { deployedEntities: string[] }).deployedEntities).toEqual([])
      // The lookup failed, so nothing was written and nothing is rollbackable.
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps the first entity rollbackable when a later one fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'first' }, { name: 'second' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 entity/)
      expect((result.artifacts as { deployedEntities: string[] }).deployedEntities).toEqual(['first'])
      // "second" never landed, so it is recorded neither as created nor as prior state.
      expect(rollbackEntries(result)).toHaveLength(1)
      expect(rollbackEntries(result)[0].name).toBe('first')
      expect(createdNames(result)).toEqual(['first'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no entity name without calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: '   ' }, { policies: ['x'] }])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
