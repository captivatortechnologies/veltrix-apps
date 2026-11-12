import React from 'react'
import { Badge, Card, CardBody } from '@veltrixsecops/app-sdk/ui'
import { CAPABILITIES } from '../../lib/capabilities'

/** Capability descriptions are public app metadata; the platform gates app access. */
export default function OverviewPage() {
  return <Card><CardBody>
    <p>Manage Microsoft Entra ID through the Configuration Canvas. Review permissions and rollback
      limits before deploying. Health reports connectivity separately from managed-resource verification.</p>
    <h3>Configuration types</h3>
    {CAPABILITIES.map(cap => <Card key={cap.id} variant="bordered" padding="md"><CardBody>
      <strong>{cap.name}</strong>{' '}
      <Badge variant={cap.appOnly ? 'secondary' : 'warning'} size="sm">{cap.appOnly ? 'App-only supported' : 'Unavailable with app-only authentication'}</Badge>
      <p>{cap.appOnly ? cap.licensing : cap.unsupportedReason}</p>
      {cap.rollbackLimits.length ? <p><strong>Rollback limits: </strong>{cap.rollbackLimits.join(' ')}</p> : null}
    </CardBody></Card>)}
  </CardBody></Card>
}
