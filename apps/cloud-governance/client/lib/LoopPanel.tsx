import React from 'react'
import { Card, CardBody } from '@veltrixsecops/app-sdk/ui'
import { ArrowRightIcon } from './icons'
import { MUTED, PANEL, ROW } from './styles'

const STEPS = [
  { title: 'Preview', body: 'Evaluate the policy and list what it would touch. Nothing changes.' },
  { title: 'Approve', body: 'A person reviews the matches. Policies set to ask wait for this.' },
  { title: 'Act', body: 'Enforce runs apply the policy actions, with snapshots where required.' },
  { title: 'Verify', body: 'A follow-up run confirms the resources now comply.' },
]

export function LoopPanel() {
  return (
    <Card>
      <CardBody>
        <ol aria-label="Governance loop" style={{ ...ROW, listStyle: 'none', margin: 0, padding: 0, gap: 12, alignItems: 'stretch' }}>
          {STEPS.map((step, i) => (
            <li key={step.title} style={{ ...ROW, flex: '1 1 180px', gap: 12 }}>
              <div style={{ ...PANEL, flex: 1 }}>
                <strong>{i + 1}. {step.title}</strong>
                <div style={MUTED}>{step.body}</div>
              </div>
              {i < STEPS.length - 1 && <ArrowRightIcon />}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  )
}
