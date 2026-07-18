import React, { useMemo } from 'react'
import { Alert, Badge, Button, Modal, Spinner } from '../../ui'
import { buildByolPlan } from '../diffPlan'
import type { ByolResource } from '../types'
import { tokens } from './shared'
import { PlanGroup } from './planLines'

// =============================================================================
// DestroyPlanModal — the Destroy-side counterpart of `ByolPlanModal`.
//
// "Destroy infrastructure" used to show a generic "Destroy all resources? This
// cannot be undone." text confirmation. That hid exactly what would be torn
// down. This renders a real Terraform-style destroy plan instead: every CURRENT
// resource as a destroy (−) line, grouped by tier — built by feeding the
// current resources through `buildByolPlan(current, [])` (an empty desired set
// means every resource is classified `destroy`), so it shares the exact plan
// model AND row rendering (`PlanGroup`/`PlanLine`) the Apply-plan modal uses.
// Only on confirming the in-modal danger Destroy button does the caller invoke
// the real `/destroy` action — never a native dialog.
// =============================================================================

export interface DestroyPlanModalProps {
  isOpen: boolean
  onClose: () => void
  /** The current persisted resources this destroy will tear down; null while (re)loading. */
  resources: ByolResource[] | null
  /** True while the resource inventory is being (re)loaded. */
  loading?: boolean
  /** A destroy-action error (from the `/destroy` call itself) to surface inline. */
  error?: string | null
  /** True while the destroy request is in flight. */
  destroying?: boolean
  /** Invoked by the primary (danger) Destroy button. */
  onConfirm: () => void
  /** Optional environment name, shown in the subtitle. */
  infraName?: string
}

/**
 * The Destroy modal. Shows every resource in `resources` as a destroy line
 * grouped by tier. Destroy stays enabled even when the inventory hasn't
 * loaded or is empty — the underlying `/destroy` action doesn't depend on this
 * preview, so an unavailable/empty list must never block the user from tearing
 * an environment down, only inform them the resource list itself was unavailable.
 */
export const DestroyPlanModal: React.FC<DestroyPlanModalProps> = ({
  isOpen,
  onClose,
  resources,
  loading,
  error,
  destroying,
  onConfirm,
  infraName,
}) => {
  const plan = useMemo(() => (resources ? buildByolPlan(resources, []) : null), [resources])
  const destroyCount = plan?.summary.destroy ?? 0
  const confirmDisabled = loading || destroying

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title="Destroy infrastructure"
      subtitle={
        infraName
          ? `Every resource for "${infraName}" will be torn down.`
          : 'Every resource for this environment will be torn down.'
      }
      disableBackdropClose={destroying}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={destroying}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} isLoading={destroying} disabled={confirmDisabled}>
            Destroy
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Alert variant="danger" title="This cannot be undone">
          Destroying removes every instance, storage volume, and network resource provisioned for this environment.
        </Alert>

        {error ? <div style={{ fontSize: 13, color: tokens.danger }}>{error}</div> : null}

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', color: tokens.muted, fontSize: 13 }}>
            <Spinner size="sm" /> Loading current resources…
          </div>
        ) : (
          <>
            <Badge variant="danger" size="sm">−{destroyCount} to destroy</Badge>
            {plan && plan.groups.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {plan.groups.map((group) => (
                  <PlanGroup key={group.tier} tier={group.tier} items={group.items} />
                ))}
              </div>
            ) : (
              <div
                style={{
                  fontSize: 13,
                  color: tokens.muted,
                  background: tokens.surface2,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  padding: '10px 14px',
                }}
              >
                No resource inventory is available for this environment — it will still be destroyed.
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

export default DestroyPlanModal
