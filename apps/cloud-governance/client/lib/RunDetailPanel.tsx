import React, { useState } from 'react'
import { Badge, Button, DataTable, EmptyState, Modal, Spinner, StatsCard, type DataTableColumn } from '@veltrixsecops/app-sdk/ui'
import { api, cancelRun, useLoad, type RunDetail, type RunActionDto, type RunMatchDto } from './api'
import { EvaluationIndicator, RunStatusPill } from './RunBadges'
import { OUTCOME_VARIANT, formatTime, isActive } from './labels'
import { GRID, MONO, MUTED, PANEL, ROW } from './styles'
import { ClockIcon } from './icons'

const matchColumns: DataTableColumn<RunMatchDto>[] = [
  { key: 'resourceType', header: 'Type' },
  { key: 'resourceId', header: 'Resource', render: (m) => <span><strong>{m.name || m.resourceId}</strong>{m.name ? <div style={{ ...MONO, ...MUTED }}>{m.resourceId}</div> : null}</span> },
  { key: 'region', header: 'Region' },
  { key: 'owner', header: 'Owner', render: (m) => m.owner ?? '—' },
  {
    key: 'tags',
    header: 'Tags',
    render: (m) => {
      const tags = Object.entries(m.tags)
      return tags.length ? <div style={ROW}>{tags.slice(0, 4).map(([k, v]) => <Badge key={k} size="sm" variant="secondary">{`${k}=${v}`}</Badge>)}{tags.length > 4 ? <span style={MUTED}>+{tags.length - 4}</span> : null}</div> : '—'
    },
  },
]

const actionColumns: DataTableColumn<RunActionDto>[] = [
  { key: 'resourceId', header: 'Resource', render: (a) => <span style={MONO}>{a.resourceId}</span> },
  { key: 'action', header: 'Action' },
  { key: 'outcome', header: 'Outcome', render: (a) => <Badge size="sm" variant={OUTCOME_VARIANT[a.outcome] ?? 'default'}>{a.outcome}</Badge> },
  { key: 'message', header: 'Message', render: (a) => a.message ?? '—' },
  { key: 'at', header: 'When', render: (a) => formatTime(a.at) },
]

interface Props {
  runId: string
  dispatchPending?: boolean
  onClose: () => void
  onChanged: () => void
}

export function RunDetailPanel({ runId, dispatchPending, onClose, onChanged }: Props) {
  const detail = useLoad(() => api<RunDetail>(`/runs/${encodeURIComponent(runId)}`), [runId], (d) => (d && isActive(d.run) ? 10000 : null))
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const run = detail.data?.run

  const cancel = async () => {
    setCancelling(true)
    setCancelError(null)
    try {
      await cancelRun(runId)
      await detail.reload()
      onChanged()
    } catch (e) {
      setCancelError((e as Error).message)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="xl"
      title={run ? `${run.kind === 'preview' ? 'Preview' : 'Enforce'} run` : 'Run'}
      subtitle={detail.data?.policy?.name}
      footer={
        <>
          {run && isActive(run) && <Button variant="danger" isLoading={cancelling} onClick={cancel}>Cancel run</Button>}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      }
    >
      {detail.loading && !detail.data ? <Spinner label="Loading run…" /> : null}
      {detail.error && <EmptyState title="Could not load the run" description={detail.error} />}
      {detail.data && run && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {dispatchPending && run.status === 'queued' && (
            <div role="status" style={PANEL}>This run is queued and waiting for the platform runner to pick it up. It will start automatically.</div>
          )}
          {cancelError && <p role="alert" style={{ color: 'rgb(var(--color-danger-rgb, var(--color-danger)))', margin: 0 }}>{cancelError}</p>}
          <div style={ROW}>
            <RunStatusPill status={run.status} />
            <EvaluationIndicator run={run} />
            {run.message && <span style={MUTED}>{run.message}</span>}
          </div>
          <div style={GRID}>
            <StatsCard label="Matched" value={run.counts.matched ?? 0} />
            <StatsCard label="Acted" value={run.counts.acted ?? 0} variant="success" />
            <StatsCard label="Failed" value={run.counts.failed ?? 0} variant={run.counts.failed ? 'danger' : 'default'} />
            <StatsCard label="Skipped" value={run.counts.skipped ?? 0} />
          </div>
          <ol aria-label="Run timeline" style={{ ...ROW, listStyle: 'none', margin: 0, padding: 0, gap: 24 }}>
            {([['Created', run.createdAt], ['Started', run.startedAt], ['Finished', run.finishedAt]] as const).map(([label, at]) => (
              <li key={label} style={{ ...ROW, gap: 6 }}><ClockIcon /><span style={MUTED}>{label}</span><span>{formatTime(at)}</span></li>
            ))}
          </ol>
          <section aria-labelledby="matched-heading">
            <h3 id="matched-heading" style={{ margin: '0 0 8px' }}>Matched resources</h3>
            <DataTable columns={matchColumns} data={detail.data.matches} rowKey={(m) => m.id} emptyState={{ title: 'No matching resources' }} />
          </section>
          <section aria-labelledby="actions-heading">
            <h3 id="actions-heading" style={{ margin: '0 0 8px' }}>Actions</h3>
            <DataTable columns={actionColumns} data={detail.data.actions} rowKey={(a) => a.id} emptyState={{ title: 'No actions taken', description: run.kind === 'preview' ? 'Previews never change resources.' : undefined }} />
          </section>
        </div>
      )}
    </Modal>
  )
}
