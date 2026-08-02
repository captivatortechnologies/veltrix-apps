import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Endpoint identity groups']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'enable-ers',
      label: '1. Enable ERS',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the ISE PAN/admin node, go to <strong>Administration &gt; System &gt; Settings &gt; API
              Settings &gt; ERS Settings</strong> and enable <strong>&quot;ERS (Read/Write)&quot;</strong>.
              This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              ERS runs on its own fixed HTTPS port, <code>9060</code>, which is closed until enabled — a
              request against it will simply time out rather than return an error until this step is done.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'admin-account',
      label: '2. Administrator account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create (or reuse) an ISE administrator whose admin group includes{' '}
              <strong>ERS-Admin</strong> (read/write — required to deploy) or{' '}
              <strong>ERS-Operator</strong> (read-only — sufficient for drift detection only).
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '3. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store that administrator as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the ISE administrator username
              </li>
              <li>
                <strong>Password</strong> → that administrator's password
              </li>
            </ul>
            <p>ERS authenticates with plain HTTP Basic on every request — there is no separate API token.</p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '4. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Under <strong>Connections</strong>, add the PAN/admin node's hostname and ERS port, e.g.{' '}
              <code>ise-pan.example.com:9060</code>, and attach the credential. Registering a connection
              also creates the <code>cisco-ise</code> deploy target used by the pipeline.
            </p>
            <p>
              ISE ships a <strong>self-signed certificate</strong> on the ERS port by default — TLS
              verification is off unless you turn on the app's <strong>&quot;Verify TLS certificate&quot;</strong>{' '}
              setting (do so once a CA-signed certificate is installed).
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
