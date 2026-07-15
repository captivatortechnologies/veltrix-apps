import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listCredentials,
  createCredential,
  updateCredential,
  removeCredential,
  listEnvironments,
  resolveTool,
  testConnection,
  type CredentialSummary,
  type EnvironmentRef,
  type TestConnectionResult,
} from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Input,
  Select,
  FormDialog,
  DataTable,
  FilterBar,
  SortSelect,
  Pagination,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '@veltrixsecops/app-sdk/ui'

// The platform Tool is upserted keyed by the app's manifest name; resolveTool
// matches on it so new connections attach to this app's tool.
const APP_NAME = 'Okta'
// Manifest id — used to reach this app's connectivity-test route.
const APP_ID = 'okta-identity'

/** Per-connection test state: in-flight, or the last result. */
type TestState = { loading: true } | TestConnectionResult

// How a connection authenticates. The secret is write-only: for "password" it
// is the account password, for "token" it is an API token.
const AUTH_TYPES = [
  { value: 'password', label: 'Username & password' },
  { value: 'token', label: 'API token' },
]

// Map the auth choice to/from the platform credential `type`. Token secrets are
// only encrypted at rest for 'API_KEY'/'TOKEN' — so token auth stores 'TOKEN'.
function toCredentialType(authType: string): string {
  return authType === 'token' ? 'TOKEN' : 'PASSWORD'
}
function fromCredentialType(type: string | null | undefined): string {
  return type === 'TOKEN' ? 'token' : 'password'
}

interface FormState {
  name: string
  environmentId: string
  authType: string
  username: string
  secret: string
  endpoint: string
}

const BLANK_FORM: FormState = {
  name: '',
  environmentId: '',
  authType: 'password',
  username: '',
  secret: '',
  endpoint: '',
}

/**
 * Connections — the credentials this app authenticates with (username/password,
 * API key, secret) plus the API endpoint each reaches. A connection is pure
 * auth: it holds NO servers/IPs/domains — those live on Access Servers, which
 * pick a connection to use. Secrets are write-only: they can be set here but are
 * never read back — the table only shows whether a secret is stored.
 */
export default function ConnectionsPage() {
  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [environments, setEnvironments] = useState<EnvironmentRef[]>([])
  const [toolId, setToolId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Search / filter / sort / pagination — the page owns the list state,
  // DataTable just renders whatever page of rows results.
  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [authTypeFilter, setAuthTypeFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CredentialSummary | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const tool = await resolveTool(APP_NAME)
      setToolId(tool?.id ?? null)
      const [creds, envs] = await Promise.all([
        tool ? listCredentials(tool.id) : Promise.resolve([] as CredentialSummary[]),
        listEnvironments(),
      ])
      setConnections(creds)
      setEnvironments(envs)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: CredentialSummary) => {
    setEditing(row)
    setForm({
      name: row.name ?? '',
      environmentId: row.tags?.[0]?.id ?? '',
      authType: fromCredentialType(row.type),
      username: row.username ?? '',
      // Secret is write-only; start blank and only rotate when the user types.
      secret: '',
      endpoint: row.endpoint ?? '',
    })
    setFormError(null)
    setDialogOpen(true)
  }

  // Memoized so FormDialog's focus effect doesn't steal focus while typing.
  const closeDialog = useCallback(() => {
    if (submitting) return
    setDialogOpen(false)
  }, [submitting])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = async () => {
    const name = form.name.trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    if (!form.environmentId) {
      setFormError('Environment is required')
      return
    }
    setSubmitting(true)
    setFormError(null)

    const secret = form.secret.trim()
    const username = form.username.trim()
    const endpoint = form.endpoint.trim()
    const tagIds = [form.environmentId]

    try {
      if (editing) {
        const update: Record<string, unknown> = {
          name,
          username,
          type: toCredentialType(form.authType),
          endpoint,
          tagIds,
        }
        if (secret) {
          if (form.authType === 'token') update.apiToken = secret
          else update.password = secret
        }
        await updateCredential(editing.id, update)
      } else {
        const tool = await resolveTool(APP_NAME)
        if (!tool) {
          throw new Error(
            `No "${APP_NAME}" tool found for your organization — make sure the app is installed before adding connections.`,
          )
        }
        await createCredential({
          name,
          username,
          password: form.authType === 'password' ? secret : '',
          apiToken: form.authType === 'token' ? secret : undefined,
          type: toCredentialType(form.authType),
          endpoint,
          toolId: tool.id,
          tagIds,
        })
      }
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: CredentialSummary) => {
    if (!window.confirm(`Remove the connection "${row.name}"? This cannot be undone.`)) return
    try {
      await removeCredential(row.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleTest = async (row: CredentialSummary) => {
    setTests((t) => ({ ...t, [row.id]: { loading: true } }))
    try {
      const result = await testConnection(APP_ID, row.id)
      setTests((t) => ({ ...t, [row.id]: result }))
    } catch (e) {
      setTests((t) => ({ ...t, [row.id]: { ok: false, message: (e as Error).message } }))
    }
  }

  const columns: DataTableColumn<CredentialSummary>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    {
      key: 'environment',
      header: 'Environment',
      render: (row) =>
        row.tags && row.tags.length > 0 ? (
          <Badge variant="info" size="sm">
            {row.tags[0].name}
          </Badge>
        ) : (
          <Badge variant="warning" size="sm">
            none
          </Badge>
        ),
    },
    { key: 'username', header: 'Username', render: (row) => row.username || '—' },
    {
      key: 'auth',
      header: 'Auth',
      render: (row) => (
        <Badge variant={row.hasSecret ? 'success' : 'warning'} size="sm">
          {row.type === 'TOKEN' ? 'token' : 'password'}
          {row.hasSecret ? '' : ' · no secret'}
        </Badge>
      ),
    },
    { key: 'endpoint', header: 'Endpoint', render: (row) => row.endpoint || '—' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        const t = tests[row.id]
        const loading = !!t && 'loading' in t
        const result = t && !('loading' in t) ? t : null
        return (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
            {result ? (
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 340 }}
                title={[result.message, ...(result.details ?? [])].filter(Boolean).join('\n')}
              >
                <Badge variant={result.ok ? 'success' : 'danger'} size="sm">
                  {result.ok ? '✓' : '✗'}
                </Badge>
                <span
                  style={{
                    fontSize: 12,
                    color: result.ok ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #dc2626)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {result.message}
                  {result.latencyMs != null ? ` · ${result.latencyMs} ms` : ''}
                </span>
              </span>
            ) : null}
            <Button variant="ghost" size="sm" isLoading={loading} onClick={() => void handleTest(row)}>
              Test
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void handleDelete(row)}>
              Remove
            </Button>
          </div>
        )
      },
    },
  ]

  const secretLabel = form.authType === 'token' ? 'API token' : 'Password'
  const usernameLabel = form.authType === 'token' ? 'Username (optional)' : 'Username'
  const environmentOptions = [
    { value: '', label: environments.length ? '— Select environment —' : '— No environments —' },
    ...environments.map((e) => ({ value: e.id, label: e.name })),
  ]

  // Toolbar filter/sort option lists.
  const environmentFilterOptions = environments.map((e) => ({ value: e.id, label: e.name }))
  const authTypeFilterOptions = AUTH_TYPES
  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'environment', label: 'Environment' },
    { value: 'username', label: 'Username' },
  ]
  const filters: FilterDefinition[] = [
    {
      key: 'environment',
      label: 'Environment',
      options: environmentFilterOptions,
      value: environmentFilter,
      onChange: setEnvironmentFilter,
      alwaysVisible: true,
    },
    {
      key: 'authType',
      label: 'Auth method',
      options: authTypeFilterOptions,
      value: authTypeFilter,
      onChange: setAuthTypeFilter,
    },
  ]

  // search -> filter -> sort, then slice to the current page.
  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = connections.filter((row) => {
      if (term) {
        const haystack = `${row.name ?? ''} ${row.username ?? ''} ${row.endpoint ?? ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (environmentFilter && row.tags?.[0]?.id !== environmentFilter) return false
      if (authTypeFilter && fromCredentialType(row.type) !== authTypeFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'environment':
          return (a.tags?.[0]?.name ?? '').localeCompare(b.tags?.[0]?.name ?? '') * dir
        case 'username':
          return (a.username ?? '').localeCompare(b.username ?? '') * dir
        case 'name':
        default:
          return (a.name ?? '').localeCompare(b.name ?? '') * dir
      }
    })
  }, [connections, search, environmentFilter, authTypeFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  // Any change to search/filters/sort invalidates the current page.
  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, authTypeFilter, sortField, sortDir])

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              Add connection
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Connections</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load connections: {error}</p>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <FilterBar
                search={{ value: search, onChange: setSearch, placeholder: 'Search connections…' }}
                filters={filters}
                onClearAll={() => {
                  setSearch('')
                  setEnvironmentFilter(null)
                  setAuthTypeFilter(null)
                }}
              />
              <SortSelect
                options={sortOptions}
                value={sortField}
                direction={sortDir}
                onChange={(field, direction) => {
                  setSortField(field)
                  setSortDir(direction)
                }}
              />
            </div>
            <DataTable
              columns={columns}
              data={pageRows}
              rowKey={(row) => row.id}
              isLoading={isLoading}
              emptyState={{
                title: 'No connections yet',
                description:
                  'Add the credentials this app authenticates with (username/password or API token) and the endpoint they reach.',
              }}
            />
            <div style={{ marginTop: 12 }}>
              <Pagination
                page={page}
                pageSize={pageSize}
                totalItems={filteredSorted.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                pageSizeOptions={[10, 25, 50]}
              />
            </div>
          </>
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit connection "${editing.name}"` : 'Add connection'}
        description="Credentials this app authenticates with, plus the API endpoint they reach. Used by Access Servers."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Add connection'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim() || !form.environmentId}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. Production API"
            fullWidth
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Environment"
            options={environmentOptions}
            value={form.environmentId}
            onChange={(value) => setField('environmentId', value)}
            helperText="The deployment scope this connection belongs to. Manage environments under Environments."
            fullWidth
          />
          <Input
            label="Endpoint (optional)"
            value={form.endpoint}
            onChange={(e) => setField('endpoint', e.target.value)}
            placeholder="e.g. https://dev-12345.okta.com"
            helperText="Your Okta org domain — the base URL of the Okta Management API this connection reaches. The SSWS API token goes in the API token field below."
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Auth method"
            options={AUTH_TYPES}
            value={form.authType}
            onChange={(value) => setField('authType', value)}
            fullWidth
          />
          <Input
            label={usernameLabel}
            value={form.username}
            onChange={(e) => setField('username', e.target.value)}
            placeholder={form.authType === 'token' ? 'service account (optional)' : 'e.g. svc_veltrix'}
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            label={secretLabel}
            type="password"
            value={form.secret}
            onChange={(e) => setField('secret', e.target.value)}
            placeholder={editing ? 'leave blank to keep current' : ''}
            helperText="Write-only — stored securely and never shown again."
            fullWidth
            autoComplete="new-password"
          />
        </div>
      </FormDialog>
    </Card>
  )
}
