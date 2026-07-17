import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '../client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Input,
  Select,
  Alert,
  FormDialog,
  DataTable,
  FilterBar,
  SortSelect,
  Pagination,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '../ui'
import {
  type ByolInfrastructure,
  type ByolInfrastructureManagerProps,
  type Tag,
  type CloudProvider,
  type CloudRegion,
  type CloudAccount,
  type FormState,
  SELF_HOSTED,
  SELF_HOSTED_LABEL,
  DEFAULT_DEPLOYMENT_TYPES,
  NETWORK_MODE_OPTIONS,
  DNS_MODE_OPTIONS,
  BYOC_NETWORK_MODES,
  CONTROL_PLANE_LAYOUT_OPTIONS,
  INSTANCE_TYPE_EXAMPLES,
  BLANK_FORM,
} from './types'
import { StatusPill, tokens } from './detail/shared'
import { errorText, formatDate } from './api'
import { ByolInfrastructureDetail } from './ByolInfrastructureDetail'
import { ClusterPlacementField } from './ClusterPlacementField'
import { validatePlacement } from './placement'

/**
 * Reusable BYOL infrastructure manager: a searchable/filterable list whose rows
 * open a full deployment console (the detail view), a Provider picker (platform
 * cloud providers plus Self-Hosted), an Environment picker fed by the customer's
 * tags, and a cloud region picker shown only for a distributed cloud deployment.
 * The app owns the data (its own DB table + routes); this component owns the UI.
 */
export const ByolInfrastructureManager: React.FC<ByolInfrastructureManagerProps> = ({
  apiBase,
  title = 'BYOL Infrastructure',
  deploymentTypes = DEFAULT_DEPLOYMENT_TYPES,
  configBase,
  configLinks,
}) => {
  const [infrastructure, setInfrastructure] = useState<ByolInfrastructure[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [cloudProviders, setCloudProviders] = useState<CloudProvider[]>([])
  const [regions, setRegions] = useState<CloudRegion[]>([])
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Master→detail: which infrastructure (if any) is open.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('infra')
  })
  const [reloadSignal, setReloadSignal] = useState(0)

  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [deploymentFilter, setDeploymentFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ByolInfrastructure | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(apiBase)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: ByolInfrastructure[]) => setInfrastructure(Array.isArray(data) ? data : []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [apiBase])

  useEffect(() => {
    void load()
  }, [load])

  // Reference lists: environment tags + platform cloud providers + cloud account
  // connections (for BYOC deployment targets). Best-effort.
  useEffect(() => {
    authFetch('/api/tags')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Tag[]) => setTags(Array.isArray(data) ? data : []))
      .catch(() => setTags([]))
    authFetch('/api/cloud-providers')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudProvider[]) =>
        setCloudProviders(Array.isArray(data) ? data.filter((c) => c.isActive !== false) : []),
      )
      .catch(() => setCloudProviders([]))
    authFetch('/api/cloud-accounts')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudAccount[]) => setCloudAccounts(Array.isArray(data) ? data : []))
      .catch(() => setCloudAccounts([]))
  }, [])

  const isCloud = form.providerId !== '' && form.providerId !== SELF_HOSTED
  const showRegion = isCloud && form.deploymentType === 'distributed'
  const showCloudAccount = BYOC_NETWORK_MODES.has(form.networkMode)

  // Load the selected cloud provider's regions when needed for the region picker.
  useEffect(() => {
    if (!isCloud) {
      setRegions([])
      return
    }
    let cancelled = false
    authFetch(`/api/cloud-providers/${form.providerId}/regions`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudRegion[]) => {
        if (!cancelled) setRegions(Array.isArray(data) ? data.filter((r) => r.isActive !== false) : [])
      })
      .catch(() => {
        if (!cancelled) setRegions([])
      })
    return () => {
      cancelled = true
    }
  }, [isCloud, form.providerId])

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: ByolInfrastructure) => {
    const providerId = row.cloudProviderId
      ? row.cloudProviderId
      : row.hosting_type === SELF_HOSTED_LABEL
        ? SELF_HOSTED
        : ''
    setEditing(row)
    setForm({
      name: row.name ?? '',
      deploymentType: row.deploymentType ?? 'single',
      environmentType: row.environmentType ?? '',
      providerId,
      region: row.region ?? '',
      indexerCount: String(row.indexerCount ?? 1),
      searchHeadCount: String(row.searchHeadCount ?? 1),
      networkMode: row.networkMode ?? 'shared',
      dnsMode: row.dnsMode ?? 'managed',
      cloudAccountConnectionId: row.cloudAccountConnectionId ?? '',
      controlPlaneLayout: row.controlPlaneLayout ?? 'dedicated',
      heavyForwarderCount: String(row.heavyForwarderCount ?? 1),
      instanceType: row.instanceType ?? '',
      indexerPlacement: row.indexerPlacement ?? { mode: 'single' },
      searchHeadPlacement: row.searchHeadPlacement ?? { mode: 'single' },
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

  // A cloud account is scoped to a provider — switching providers invalidates any
  // previously selected account (the Cloud account options are recomputed to match
  // the new provider, so keeping the stale id around would let it slip into submit).
  const handleProviderChange = (value: string) =>
    setForm((prev) => ({ ...prev, providerId: value, cloudAccountConnectionId: '' }))

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    const indexerCount = Number(form.indexerCount)
    const searchHeadCount = Number(form.searchHeadCount)
    if (form.deploymentType === 'distributed') {
      if (indexerCount < 3) {
        setFormError('Distributed deployments require at least 3 indexers')
        return
      }
      if (searchHeadCount < 2) {
        setFormError('Distributed deployments require at least 2 search heads')
        return
      }
      if (showRegion) {
        const indexerErr = validatePlacement(form.indexerPlacement, indexerCount)
        if (indexerErr) {
          setFormError(`Indexer placement: ${indexerErr}`)
          return
        }
        const searchErr = validatePlacement(form.searchHeadPlacement, searchHeadCount)
        if (searchErr) {
          setFormError(`Search head placement: ${searchErr}`)
          return
        }
      }
    }
    if (showCloudAccount && !form.cloudAccountConnectionId) {
      setFormError('Select a verified cloud account for a BYOC deployment target')
      return
    }
    const selfHosted = form.providerId === SELF_HOSTED
    const selectedCloud = cloudProviders.find((c) => c.id === form.providerId)
    const distributed = form.deploymentType === 'distributed'
    // Placement only applies to a distributed cloud deployment (needs AZs/regions);
    // single-instance or self-hosted always collapses to a single site.
    const normalizePlacement = (p: FormState['indexerPlacement']) =>
      distributed && showRegion && p?.mode === 'multi-site' ? p : { mode: 'single' as const }
    setSubmitting(true)
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      deploymentType: form.deploymentType,
      environmentType: form.environmentType,
      hosting_type: selfHosted ? SELF_HOSTED_LABEL : (selectedCloud?.name ?? ''),
      cloudProviderId: selfHosted ? undefined : form.providerId || undefined,
      region: showRegion ? form.region : '',
      indexerCount,
      searchHeadCount,
      networkMode: form.networkMode,
      dnsMode: form.dnsMode,
      cloudAccountConnectionId: showCloudAccount ? form.cloudAccountConnectionId : undefined,
      // Topology authoring — only meaningful for distributed deployments.
      controlPlaneLayout: distributed ? form.controlPlaneLayout : 'dedicated',
      heavyForwarderCount: distributed ? Math.max(1, Number(form.heavyForwarderCount) || 1) : 1,
      // Compute size override; empty → the cloud default (t2.medium-class). Only
      // meaningful for a cloud deployment.
      instanceType: !selfHosted ? form.instanceType.trim() || undefined : undefined,
      indexerPlacement: normalizePlacement(form.indexerPlacement),
      searchHeadPlacement: normalizePlacement(form.searchHeadPlacement),
    }
    try {
      const res = await authFetch(editing ? `${apiBase}/${editing.id}` : apiBase, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorText(res))
      setDialogOpen(false)
      await load()
      // If we edited the open infrastructure, refresh the detail view too.
      if (editing) setReloadSignal((n) => n + 1)
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const openDetail = (id: string | null) => {
    setSelectedId(id)
    if (typeof window !== 'undefined' && id === null) {
      const params = new URLSearchParams(window.location.search)
      params.delete('infra')
      params.delete('section')
      const qs = params.toString()
      window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
    }
  }

  const columns: DataTableColumn<ByolInfrastructure>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'deploymentType', header: 'Deployment', render: (row) => row.deploymentType ?? '—' },
    { key: 'environmentType', header: 'Environment', render: (row) => row.environmentType ?? '—' },
    { key: 'hosting_type', header: 'Provider', render: (row) => row.hosting_type ?? '—' },
    { key: 'region', header: 'Region', render: (row) => row.region || '—' },
    { key: 'indexerCount', header: 'Indexers', align: 'right', render: (row) => row.indexerCount ?? '—' },
    { key: 'searchHeadCount', header: 'Search heads', align: 'right', render: (row) => row.searchHeadCount ?? '—' },
    { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'updatedAt', header: 'Updated', render: (row) => formatDate(row.updatedAt) },
    { key: 'chevron', header: '', align: 'right', width: '32px', render: () => <span aria-hidden style={{ color: 'var(--color-text-subtle, #9ca3af)' }}>›</span> },
  ]

  const environmentOptions = useMemo(() => tags.map((t) => ({ value: t.name, label: t.name })), [tags])
  const providerOptions = useMemo(
    () => [
      { value: SELF_HOSTED, label: SELF_HOSTED_LABEL },
      ...cloudProviders.map((c) => ({ value: c.id, label: c.name })),
    ],
    [cloudProviders],
  )
  const regionOptions = useMemo(
    () => regions.map((r) => ({ value: r.code, label: `${r.name} (${r.code})` })),
    [regions],
  )
  const selectedProvider = useMemo(
    () => cloudProviders.find((c) => c.id === form.providerId),
    [cloudProviders, form.providerId],
  )
  // Only verified accounts, narrowed to the selected cloud provider (when one is picked).
  const verifiedCloudAccounts = useMemo(
    () =>
      cloudAccounts.filter(
        (a) => a.status === 'VERIFIED' && (!selectedProvider?.code || a.provider === selectedProvider.code),
      ),
    [cloudAccounts, selectedProvider],
  )
  const cloudAccountOptions = useMemo(
    () => verifiedCloudAccounts.map((a) => ({ value: a.id, label: `${a.name} (${a.provider})` })),
    [verifiedCloudAccounts],
  )

  const statusFilterOptions = useMemo(() => {
    const seen = new Set<string>()
    infrastructure.forEach((i) => seen.add(i.status ?? 'unknown'))
    return Array.from(seen, (value) => ({ value, label: value }))
  }, [infrastructure])

  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'indexerCount', label: 'Indexers' },
    { value: 'searchHeadCount', label: 'Search heads' },
    { value: 'status', label: 'Status' },
    { value: 'updatedAt', label: 'Updated' },
  ]
  const filters: FilterDefinition[] = [
    { key: 'environment', label: 'Environment', options: environmentOptions, value: environmentFilter, onChange: setEnvironmentFilter, alwaysVisible: true },
    { key: 'deployment', label: 'Deployment', options: deploymentTypes, value: deploymentFilter, onChange: setDeploymentFilter },
    { key: 'status', label: 'Status', options: statusFilterOptions, value: statusFilter, onChange: setStatusFilter },
  ]

  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = infrastructure.filter((row) => {
      if (term) {
        const haystack = `${row.name ?? ''} ${row.hosting_type ?? ''} ${row.region ?? ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (environmentFilter && row.environmentType !== environmentFilter) return false
      if (deploymentFilter && row.deploymentType !== deploymentFilter) return false
      if (statusFilter && (row.status ?? 'unknown') !== statusFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'indexerCount':
          return ((a.indexerCount ?? 0) - (b.indexerCount ?? 0)) * dir
        case 'searchHeadCount':
          return ((a.searchHeadCount ?? 0) - (b.searchHeadCount ?? 0)) * dir
        case 'status':
          return (a.status ?? '').localeCompare(b.status ?? '') * dir
        case 'updatedAt':
          return (new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()) * dir
        case 'name':
        default:
          return (a.name ?? '').localeCompare(b.name ?? '') * dir
      }
    })
  }, [infrastructure, search, environmentFilter, deploymentFilter, statusFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, deploymentFilter, statusFilter, sortField, sortDir])

  const selected = selectedId ? infrastructure.find((i) => i.id === selectedId) ?? null : null

  // --- Detail view (master→detail swap) ---
  if (selectedId && selected) {
    return (
      <>
        <ByolInfrastructureDetail
          apiBase={apiBase}
          initialInfra={selected}
          configBase={configBase}
          configLinks={configLinks}
          reloadSignal={reloadSignal}
          onBack={() => openDetail(null)}
          onEdit={openEdit}
          onDeleted={() => {
            openDetail(null)
            void load()
          }}
          onChanged={() => void load()}
        />
        <FormDialog
          isOpen={dialogOpen}
          onClose={closeDialog}
          title={editing ? `Edit "${editing.name}"` : 'New BYOL infrastructure'}
          description="Define the deployment topology for a Bring-Your-Own-License Splunk environment."
          onSubmit={handleSubmit}
          submitText={editing ? 'Save changes' : 'Create infrastructure'}
          isSubmitting={submitting}
          submitDisabled={!form.name.trim() || (showCloudAccount && !form.cloudAccountConnectionId)}
          error={formError}
          size="md"
        >
          <FormBody
            form={form}
            setField={setField}
            onProviderChange={handleProviderChange}
            deploymentTypes={deploymentTypes}
            environmentOptions={environmentOptions}
            providerOptions={providerOptions}
            regionOptions={regionOptions}
            showRegion={showRegion}
            showCloudAccount={showCloudAccount}
            cloudAccountOptions={cloudAccountOptions}
            selectedProviderName={selectedProvider?.name}
          />
        </FormDialog>
      </>
    )
  }

  // --- List view ---
  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              New infrastructure
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p style={{ color: 'var(--color-danger, #dc2626)' }}>Failed to load BYOL infrastructure: {error}</p>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <FilterBar
            search={{ value: search, onChange: setSearch, placeholder: 'Search infrastructure…' }}
            filters={filters}
          />
          <SortSelect
            options={sortOptions}
            value={sortField}
            direction={sortDir}
            onChange={(field, dir) => {
              setSortField(field)
              setSortDir(dir)
            }}
          />
        </div>

        <DataTable
          columns={columns}
          data={pageRows}
          rowKey={(row) => row.id}
          isLoading={isLoading}
          onRowClick={(row) => openDetail(row.id)}
          emptyState={{
            title: 'No BYOL infrastructure yet',
            description: 'Create a BYOL deployment to manage its topology, resources and lifecycle here.',
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
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.name}"` : 'New BYOL infrastructure'}
        description="Define the deployment topology for a Bring-Your-Own-License Splunk environment."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Create infrastructure'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim() || (showCloudAccount && !form.cloudAccountConnectionId)}
        error={formError}
        size="md"
      >
        <FormBody
          form={form}
          setField={setField}
          onProviderChange={handleProviderChange}
          deploymentTypes={deploymentTypes}
          environmentOptions={environmentOptions}
          providerOptions={providerOptions}
          regionOptions={regionOptions}
          showRegion={showRegion}
          showCloudAccount={showCloudAccount}
          cloudAccountOptions={cloudAccountOptions}
          selectedProviderName={selectedProvider?.name}
        />
      </FormDialog>
    </Card>
  )
}

// --- Create/edit form body (shared by both list + detail entry points) -------

interface FormBodyProps {
  form: FormState
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  /** Provider-specific onChange (also clears a now-mismatched cloud account selection). */
  onProviderChange: (value: string) => void
  deploymentTypes: Array<{ value: string; label: string }>
  environmentOptions: Array<{ value: string; label: string }>
  providerOptions: Array<{ value: string; label: string }>
  regionOptions: Array<{ value: string; label: string }>
  showRegion: boolean
  /** Whether the current network mode is BYOC (dedicated/existing) and needs a cloud account. */
  showCloudAccount: boolean
  /** Verified cloud accounts, narrowed to the selected provider when one is picked. */
  cloudAccountOptions: Array<{ value: string; label: string }>
  /** Selected cloud provider's display name, for the "no verified account" note. */
  selectedProviderName?: string
}

/** A labelled sub-group of related fields, so the form reads as scannable sections. */
const FormSection: React.FC<{ title: string; description?: string; children: React.ReactNode }> = ({
  title,
  description,
  children,
}) => (
  <div>
    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.text }}>{title}</p>
    {description ? (
      <p style={{ margin: '2px 0 0', fontSize: 12, color: tokens.muted }}>{description}</p>
    ) : null}
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
  </div>
)

const FormBody: React.FC<FormBodyProps> = ({
  form,
  setField,
  onProviderChange,
  deploymentTypes,
  environmentOptions,
  providerOptions,
  regionOptions,
  showRegion,
  showCloudAccount,
  cloudAccountOptions,
  selectedProviderName,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Input label="Name" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Production cluster" fullWidth autoFocus />
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Select label="Deployment type" value={form.deploymentType} onChange={(value) => setField('deploymentType', value)} options={deploymentTypes} />
      <Select label="Environment" value={form.environmentType} onChange={(value) => setField('environmentType', value)} options={environmentOptions} />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: showRegion ? '1fr 1fr' : '1fr', gap: 12 }}>
      <Select label="Provider" value={form.providerId} onChange={onProviderChange} options={providerOptions} />
      {showRegion ? (
        <Select label="Region" value={form.region} onChange={(value) => setField('region', value)} options={regionOptions} />
      ) : null}
    </div>

    <FormSection title="Deployment target">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Select
          label="Network"
          value={form.networkMode}
          onChange={(value) => setField('networkMode', value)}
          options={NETWORK_MODE_OPTIONS}
        />
        <Select label="DNS" value={form.dnsMode} onChange={(value) => setField('dnsMode', value)} options={DNS_MODE_OPTIONS} />
      </div>
      {showCloudAccount ? (
        <>
          <Select
            label="Cloud account *"
            value={form.cloudAccountConnectionId}
            onChange={(value) => setField('cloudAccountConnectionId', value)}
            options={cloudAccountOptions}
            placeholder={cloudAccountOptions.length ? 'Select a verified cloud account…' : 'No verified cloud accounts'}
            disabled={cloudAccountOptions.length === 0}
            helperText="Required for a dedicated or existing-network (BYOC) deployment."
          />
          {cloudAccountOptions.length === 0 ? (
            <Alert variant="warning" title="No verified cloud account available">
              {selectedProviderName
                ? `No verified ${selectedProviderName} cloud account found. Register and verify a cloud account first in Settings → Cloud Accounts.`
                : 'Register and verify a cloud account first in Settings → Cloud Accounts.'}
            </Alert>
          ) : null}
        </>
      ) : null}
    </FormSection>

    <FormSection
      title="Topology"
      description={
        form.deploymentType === 'distributed'
          ? 'Distributed deployments need at least 3 indexers and 2 search heads.'
          : 'Number of indexer and search-head nodes to provision.'
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Input label="Indexers" type="number" min={1} value={form.indexerCount} onChange={(e) => setField('indexerCount', e.target.value)} fullWidth />
        <Input label="Search heads" type="number" min={1} value={form.searchHeadCount} onChange={(e) => setField('searchHeadCount', e.target.value)} fullWidth />
      </div>
      {form.providerId && form.providerId !== SELF_HOSTED ? (
        <Input
          label="Compute size (instance type)"
          value={form.instanceType}
          onChange={(e) => setField('instanceType', e.target.value)}
          placeholder={INSTANCE_TYPE_EXAMPLES.aws}
          fullWidth
          helperText={`Leave blank for the cloud default (~2 vCPU / 4 GB). Examples: AWS ${INSTANCE_TYPE_EXAMPLES.aws}, Azure ${INSTANCE_TYPE_EXAMPLES.azure}, GCP ${INSTANCE_TYPE_EXAMPLES.gcp}, Hetzner ${INSTANCE_TYPE_EXAMPLES.hetzner}. Applies to every node; you can change it here later.`}
        />
      ) : null}
      {showRegion ? (
        <>
          <ClusterPlacementField
            label="Indexer cluster placement"
            placement={form.indexerPlacement}
            nodeCount={Math.max(1, Number(form.indexerCount) || 1)}
            primaryRegion={form.region}
            regionOptions={regionOptions}
            onChange={(p) => setField('indexerPlacement', p)}
          />
          <ClusterPlacementField
            label="Search head cluster placement"
            placement={form.searchHeadPlacement}
            nodeCount={Math.max(1, Number(form.searchHeadCount) || 1)}
            primaryRegion={form.region}
            regionOptions={regionOptions}
            onChange={(p) => setField('searchHeadPlacement', p)}
          />
        </>
      ) : null}
    </FormSection>

    {form.deploymentType === 'distributed' ? (
      <>
        <FormSection
          title="Control plane"
          description="How many instances the five management roles run on — fewer instances cut cost, more give isolation and HA."
        >
          <Select
            label="Consolidation"
            value={form.controlPlaneLayout}
            onChange={(value) => setField('controlPlaneLayout', value as FormState['controlPlaneLayout'])}
            options={CONTROL_PLANE_LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: `${o.label} — ${o.description}` }))}
          />
        </FormSection>

        <FormSection
          title="Ingest"
          description="Heavy forwarders for ingest routing. One is provisioned by default; add more for higher throughput."
        >
          <Input
            label="Heavy forwarders"
            type="number"
            min={1}
            value={form.heavyForwarderCount}
            onChange={(e) => setField('heavyForwarderCount', e.target.value)}
            fullWidth
          />
        </FormSection>
      </>
    ) : null}
  </div>
)

export default ByolInfrastructureManager
