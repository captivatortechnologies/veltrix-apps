import React, { useMemo, useState } from 'react'
import { Button, DataTable, EmptyState, Select, type DataTableColumn } from '@veltrixsecops/app-sdk/ui'
import { api, useLoad, type PolicyDto, type RunDto } from '../lib/api'
import { EvaluationIndicator, RunStatusPill } from '../lib/RunBadges'
import { RunDetailPanel } from '../lib/RunDetailPanel'
import { RefreshIcon } from '../lib/icons'
import { RUN_STATUS, formatTime, isActive } from '../lib/labels'
import { MUTED, PAGE, ROW } from '../lib/styles'

const REFRESH_MS = 10000
const ALL = ''

const STATUS_OPTIONS = [{ value: ALL, label: 'All statuses' }, ...Object.entries(RUN_STATUS).map(([value, { label }]) => ({ value, label }))]

export default function RunsPage() {
  const [policyId, setPolicyId] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [openId, setOpenId] = useState<string | null>(null)

  const policies = useLoad(() => api<PolicyDto[]>('/policies'), [])
  const runs = useLoad(
    () => api<RunDto[]>(`/runs?limit=200${policyId ? `&policyId=${encodeURIComponent(policyId)}` : ''}`),
    [policyId],
    (data) => (data?.some(isActive) ? REFRESH_MS : null),
  )

  const policyNames = useMemo(() => new Map((policies.data ?? []).map((p) => [p.id, p.name])), [policies.data])
  const policyOptions = useMemo(
    () => [{ value: ALL, label: 'All policies' }, ...(policies.data ?? []).map((p) => ({ value: p.id, label: p.name }))],
    [policies.data],
  )
  const rows = useMemo(() => (runs.data ?? []).filter((r) => !status || r.status === status), [runs.data, status])
  const polling = runs.data?.some(isActive) ?? false

  const columns: DataTableColumn<RunDto>[] = [
    { key: 'createdAt', header: 'Created', render: (r) => formatTime(r.createdAt) },
    { key: 'policy', header: 'Policy', render: (r) => <strong>{policyNames.get(r.policyId) ?? r.policyId}</strong> },
    { key: 'kind', header: 'Kind', render: (r) => (r.kind === 'preview' ? 'Preview' : 'Enforce') },
    { key: 'status', header: 'Status', render: (r) => <RunStatusPill status={r.status} /> },
    { key: 'evaluation', header: 'Evaluation', render: (r) => <EvaluationIndicator run={r} /> },
    { key: 'matched', header: 'Matched', align: 'right', render: (r) => r.counts.matched ?? 0 },
    { key: 'acted', header: 'Acted', align: 'right', render: (r) => r.counts.acted ?? 0 },
    { key: 'failed', header: 'Failed', align: 'right', render: (r) => r.counts.failed ?? 0 },
  ]

  return (
    <div style={PAGE}>
      <div style={{ ...ROW, justifyContent: 'space-between' }}>
        <div style={ROW}>
          <Select aria-label="Filter by policy" options={policyOptions} value={policyId} onChange={setPolicyId} />
          <Select aria-label="Filter by status" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        </div>
        <div style={ROW}>
          {polling && <span role="status" style={MUTED}>Refreshing every 10 seconds</span>}
          <Button variant="secondary" size="sm" leftIcon={<RefreshIcon />} onClick={() => void runs.reload()}>Refresh</Button>
        </div>
      </div>

      {runs.error ? (
        <EmptyState title="Could not load runs" description={runs.error} action={<Button variant="secondary" onClick={() => void runs.reload()}>Retry</Button>} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.id}
          isLoading={runs.loading && !runs.data}
          onRowClick={(r) => setOpenId(r.id)}
          emptyState={{ title: 'No runs yet', description: 'Start a preview run from the Overview page and it will appear here.' }}
        />
      )}

      {openId && <RunDetailPanel runId={openId} onClose={() => setOpenId(null)} onChanged={() => void runs.reload()} />}
    </div>
  )
}
