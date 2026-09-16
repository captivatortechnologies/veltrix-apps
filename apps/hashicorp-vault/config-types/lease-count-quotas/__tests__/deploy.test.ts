import deploy, { type LeaseCountQuotaRollbackEntry } from '../deploy'
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

const DB_LEASES = { name: 'db-leases', path: 'database/', maxLeases: 1000 }

function canvasWith(quotas: Array<Record<string, unknown>>) {
  return makeCanvas(
    quotas.map((fields, i) => ({ name: `Quota ${i + 1}`, fields })),
    'lease-count-quotas',
  )
}

function entries(result: { rollbackData?: unknown }): LeaseCountQuotaRollbackEntry[] {
  return (result.rollbackData as { previousState?: LeaseCountQuotaRollbackEntry[] })?.previousState ?? []
}

function createdNames(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdNames?: string[] })?.createdNames ?? []
}

function artifacts(result: { artifacts?: unknown }) {
  return result.artifacts as { deployedQuotas: string[]; createdQuotas: string[] }
}

describe('Vault Lease Count Quotas Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES]), { token: null }))

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
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES]), { hostname: '' }))

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
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES])))

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

  it('creates a quota that does not exist yet with the exact authored cap', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/quotas/lease-count/db-leases`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/quotas/lease-count/db-leases`)
      // inheritable is always sent so clearing it on the canvas converges.
      expect(JSON.parse(write.body)).toEqual({ max_leases: 1000, path: 'database/', inheritable: false })

      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].existed).toBe(false)
      expect(entries(result)[0].path).toBe('database/')
      expect(entries(result)[0].prior).toBeUndefined()
      expect(createdNames(result)).toEqual(['db-leases'])
    } finally {
      fetchStub.restore()
    }
  })

  it('sends max_leases as a number even when the canvas supplies it as a string', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ ...DB_LEASES, maxLeases: '2500' }])))

      const body = JSON.parse(fetchStub.calls[1].body)
      expect(typeof body.max_leases).toBe('number')
      expect(body.max_leases).toBe(2500)
    } finally {
      fetchStub.restore()
    }
  })

  it('sends inheritable and role exactly as authored', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([{ name: 'ns-leases', path: 'team-a/', maxLeases: 50, inheritable: true, role: 'ci' }]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        max_leases: 50,
        path: 'team-a/',
        inheritable: true,
        role: 'ci',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('updates a quota that already exists and captures its prior cap verbatim', async () => {
    const fetchStub = recordFetch([
      {
        status: 200,
        body: {
          data: {
            type: 'lease-count',
            name: 'db-leases',
            path: 'database/creds',
            max_leases: 25,
            role: 'readonly',
            inheritable: true,
          },
        },
      },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES])))

      expect(result.success).toBe(true)
      const entry = entries(result)[0]
      expect(entry.existed).toBe(true)
      expect(entry.prior?.max_leases).toBe(25)
      expect(entry.prior?.path).toBe('database/creds')
      expect(entry.prior?.role).toBe('readonly')
      expect(entry.prior?.inheritable).toBe(true)
      expect(createdNames(result)).toEqual([])
      expect(JSON.parse(fetchStub.calls[1].body).max_leases).toBe(1000)
    } finally {
      fetchStub.restore()
    }
  })

  it('always sends the empty path of a global limiter and warns about it', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'cluster-wide', path: '', maxLeases: 5000 }])),
      )

      expect(result.success).toBe(true)
      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        max_leases: 5000,
        path: '',
        inheritable: false,
      })
      expect(result.message).toMatch(/GLOBAL lease count limiter/)
    } finally {
      fetchStub.restore()
    }
  })

  it('explains that a 404 on the write means the cluster is not Vault Enterprise', async () => {
    const fetchStub = recordFetch([NOT_FOUND, { status: 404, body: { errors: ['unsupported path'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault Enterprise/)
      expect(result.message).toMatch(/unsupported path/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/permission denied/)
      expect(result.message).toMatch(/0 of 1/)
      expect(artifacts(result).deployedQuotas).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DB_LEASES])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read lease count quota/)
      expect(artifacts(result).deployedQuotas).toEqual([])
      expect(entries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later quota fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: 'first', path: 'database/', maxLeases: 10 },
            { name: 'second', path: 'database/', maxLeases: 20 },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 2/)
      expect(artifacts(result).deployedQuotas).toEqual(['first'])
      expect(entries(result)).toHaveLength(2)
      expect(createdNames(result)).toEqual(['first', 'second'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips quotas with no name or a non-integer cap before touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: '', path: 'database/', maxLeases: 100 },
            { name: 'fractional', path: 'database/', maxLeases: 10.5 },
            { name: 'zero', path: 'database/', maxLeases: 0 },
            { name: 'unset', path: 'database/' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
