import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listCredentials,
  createCredential,
  updateCredential,
  removeCredential,
  listEnvironments,
  resolveTool,
  testConnection,
  startOnboarding,
  type CredentialSummary,
  type EnvironmentRef,
  type TestConnectionResult,
} from '../client'
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
  useConfirmDialog,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '../ui'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionsManagerProps {
  /**
   * Platform Tool name — MUST equal the app's manifest `name`. `resolveTool`
   * matches on it so new connections attach to this app's tool.
   */
  appName: string
  /** Manifest id — used to reach this app's connectivity-test route. */
  appId: string
  /** Card title. Defaults to "Connections". */
  title?: string
  /** Placeholder for the connection Name field. */
  namePlaceholder?: string
  /** Placeholder + helper for the Endpoint field. */
  endpointPlaceholder?: string
  endpointHelper?: string
  /**
   * Label for the account / key field (the credential's `username`). Defaults to
   * "Username"; pass e.g. "Access key" (Tenable) or "Client ID" (OAuth apps).
   */
  usernameLabel?: string
  /**
   * Label for the token/secret auth method + its secret field. Defaults to
   * "API token"; pass e.g. "API key" (Elastic), "Client secret" (OAuth),
   * "Secret key" (Tenable).
   */
  tokenLabel?: string
  /** Placeholder for the username field when token auth is selected. */
  tokenUsernamePlaceholder?: string
  /** Placeholder for the username field when password auth is selected. */
  passwordUsernamePlaceholder?: string
  /**
   * Whether the username field is optional under token auth (appends "(optional)"
   * to its label). Defaults to true — pass false for OAuth/key apps where the
   * username IS the required identifier (e.g. Client ID, Access key).
   */
  usernameOptionalForToken?: boolean
  /**
   * One-click onboarding descriptor (the client-safe subset the platform
   * advertises in the app's `/enabled` payload as `connection.onboarding`). When
   * provided, a primary "Connect …" button drives the platform onboarding flow
   * (e.g. Entra admin consent) — no secret is entered by the user. Omit it and
   * the manager renders exactly as before (manual "Add connection" only).
   */
  onboarding?: OnboardingDescriptorSummary
}

/** Client-safe onboarding descriptor from the `/enabled` payload. */
export interface OnboardingDescriptorSummary {
  provider: string
  /** Button/label text, e.g. "Connect Microsoft Defender". */
  label: string
  /** True → brokered (no secret ever entered by the user). */
  brokered: boolean
  /** App settings the admin must supply before the consent redirect. */
  requiredSettings: string[]
}

/** Per-connection test state: in-flight, or the last result. */
type TestState = { loading: true } | TestConnectionResult

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

// Map the auth choice to/from the platform credential `type`. Token secrets are
// only encrypted at rest for 'API_KEY'/'TOKEN' — so token auth stores 'TOKEN'.
function toCredentialType(authType: string): string {
  return authType === 'token' ? 'TOKEN' : 'PASSWORD'
}
function fromCredentialType(type: string | null | undefined): string {
  return type === 'TOKEN' ? 'token' : 'password'
}

/**
 * Reusable Connections manager: full credential CRUD (username/password or
 * token, plus the API endpoint each reaches), tied to an Environment, with a
 * per-row "Test connectivity" button that runs the app's own testConnection
 * handler. Every app renders this with its own `appName`/`appId` and auth labels;
 * the data (credentials) stays platform-owned. Secrets are write-only — set here,
 * never read back.
 */
export const ConnectionsManager: React.FC<ConnectionsManagerProps> = ({
  appName,
  appId,
  title = 'Connections',
  namePlaceholder = 'e.g. Production API',
  endpointPlaceholder = 'e.g. https://api.example.com',
  endpointHelper = 'API base URL / endpoint this connection reaches.',
  usernameLabel = 'Username',
  tokenLabel = 'API token',
  tokenUsernamePlaceholder = 'service account (optional)',
  passwordUsernamePlaceholder = 'e.g. svc_veltrix',
  usernameOptionalForToken = true,
  onboarding,
}) => {
  const { confirm } = useConfirmDialog()
  const authTypes = useMemo(
    () => [
      { value: 'password', label: 'Username & password' },
      { value: 'token', label: tokenLabel },
    ],
    [tokenLabel],
  )

  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [environments, setEnvironments] = useState<EnvironmentRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

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

  // --- One-click onboarding ("Connect …") state ---
  const [onboardOpen, setOnboardOpen] = useState(false)
  const [onboardName, setOnboardName] = useState('')
  const [onboardEnvironmentId, setOnboardEnvironmentId] = useState('')
  const [onboardSettings, setOnboardSettings] = useState<Record<string, string>>({})
  const [onboardSubmitting, setOnboardSubmitting] = useState(false)
  const [onboardError, setOnboardError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const tool = await resolveTool(appName)
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
  }, [appName])

  useEffect(() => {
    void load()
  }, [load])

  // Surface the result of a completed onboarding redirect
  // (`…/connections?onboarded=ok|error`) and strip the params from the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('onboarded')
    if (!outcome) return
    if (outcome === 'ok') {
      setNotice(
        params.get('pending') === 'manual'
          ? 'Connection created. One manual step remains — see the connection to finish setup.'
          : 'Connection created successfully.',
      )
    } else {
      setError(`Onboarding failed: ${params.get('reason') || 'unknown error'}`)
    }
    params.delete('onboarded')
    params.delete('pending')
    params.delete('reason')
    params.delete('connectionId')
    const qs = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }, [])

  const openOnboard = () => {
    setOnboardName('')
    setOnboardEnvironmentId('')
    setOnboardSettings({})
    setOnboardError(null)
    setOnboardOpen(true)
  }

  const handleStartOnboarding = async () => {
    if (!onboarding) return
    const name = onboardName.trim()
    if (!name) {
      setOnboardError('Name is required')
      return
    }
    if (!onboardEnvironmentId) {
      setOnboardError('Environment is required')
      return
    }
    const missing = onboarding.requiredSettings.filter((k) => !onboardSettings[k]?.trim())
    if (missing.length > 0) {
      setOnboardError(`Please provide: ${missing.join(', ')}`)
      return
    }
    setOnboardSubmitting(true)
    setOnboardError(null)
    try {
      const { authorizeUrl } = await startOnboarding(appId, {
        environmentId: onboardEnvironmentId,
        connectionName: name,
        settings: onboardSettings,
      })
      // Full-page navigation to the provider's hosted consent page. The
      // platform's static callback redirects back here with `?onboarded=…`.
      if (typeof window !== 'undefined') window.location.assign(authorizeUrl)
    } catch (e) {
      setOnboardError((e as Error).message)
      setOnboardSubmitting(false)
    }
  }

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
      secret: '',
      endpoint: row.endpoint ?? '',
    })
    setFormError(null)
    setDialogOpen(true)
  }

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
        const tool = await resolveTool(appName)
        if (!tool) {
          throw new Error(
            `No "${appName}" tool found for your organization — make sure the app is installed before adding connections.`,
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
    const ok = await confirm({
      title: 'Remove connection',
      message: `Remove the connection "${row.name}"? This cannot be undone.`,
      confirmText: 'Remove',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!ok) return
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
      const result = await testConnection(appId, row.id)
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
    { key: 'username', header: usernameLabel, render: (row) => row.username || '—' },
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

  const isToken = form.authType === 'token'
  const secretLabel = isToken ? tokenLabel : 'Password'
  const usernameFieldLabel =
    isToken && usernameOptionalForToken ? `${usernameLabel} (optional)` : usernameLabel
  const environmentOptions = [
    { value: '', label: environments.length ? '— Select environment —' : '— No environments —' },
    ...environments.map((e) => ({ value: e.id, label: e.name })),
  ]

  const environmentFilterOptions = environments.map((e) => ({ value: e.id, label: e.name }))
  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'environment', label: 'Environment' },
    { value: 'username', label: usernameLabel },
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
      options: authTypes,
      value: authTypeFilter,
      onChange: setAuthTypeFilter,
    },
  ]

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
            {onboarding ? (
              <Button variant="primary" size="sm" onClick={openOnboard}>
                {onboarding.label}
              </Button>
            ) : null}
            <Button variant={onboarding ? 'secondary' : 'primary'} size="sm" onClick={openCreate}>
              Add connection
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
      </CardHeader>
      <CardBody>
        {notice ? (
          <div role="status" style={{ marginBottom: 12 }}>
            <Badge variant="success" size="sm">
              {notice}
            </Badge>
          </div>
        ) : null}
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
                  'Add the credentials this app authenticates with (username/password or a token) and the endpoint they reach.',
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
        description="Credentials this app authenticates with, plus the API endpoint they reach."
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
            placeholder={namePlaceholder}
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
            placeholder={endpointPlaceholder}
            helperText={endpointHelper}
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Auth method"
            options={authTypes}
            value={form.authType}
            onChange={(value) => setField('authType', value)}
            fullWidth
          />
          <Input
            label={usernameFieldLabel}
            value={form.username}
            onChange={(e) => setField('username', e.target.value)}
            placeholder={isToken ? tokenUsernamePlaceholder : passwordUsernamePlaceholder}
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

      {onboarding ? (
        <FormDialog
          isOpen={onboardOpen}
          onClose={() => {
            if (!onboardSubmitting) setOnboardOpen(false)
          }}
          title={onboarding.label}
          description={
            onboarding.brokered
              ? "You'll approve this on your provider's sign-in page — no secret is entered or stored here."
              : "You'll authorize this on your provider's sign-in page."
          }
          onSubmit={handleStartOnboarding}
          submitText="Continue to sign-in"
          isSubmitting={onboardSubmitting}
          submitDisabled={!onboardName.trim() || !onboardEnvironmentId}
          error={onboardError}
          size="md"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Input
              label="Name"
              value={onboardName}
              onChange={(e) => setOnboardName(e.target.value)}
              placeholder={namePlaceholder}
              fullWidth
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <Select
              label="Environment"
              options={environmentOptions}
              value={onboardEnvironmentId}
              onChange={(value) => setOnboardEnvironmentId(value)}
              helperText="The deployment scope this connection belongs to."
              fullWidth
            />
            {onboarding.requiredSettings.map((key) => (
              <Input
                key={key}
                label={key}
                value={onboardSettings[key] ?? ''}
                onChange={(e) =>
                  setOnboardSettings((prev) => ({ ...prev, [key]: e.target.value }))
                }
                fullWidth
                spellCheck={false}
                autoComplete="off"
              />
            ))}
          </div>
        </FormDialog>
      ) : null}
    </Card>
  )
}

export default ConnectionsManager
