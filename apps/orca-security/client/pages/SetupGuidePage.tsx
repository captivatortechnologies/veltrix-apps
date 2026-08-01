import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Custom alerts (custom Sonar rules)']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-token',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Orca, go to <strong>Settings &gt; Users &amp; Permissions &gt; API</strong>, open{' '}
              <strong>API Tokens</strong> and click <strong>Add API Token</strong>. Give it permissions to
              manage what this app configures:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the token — it is sent to the Orca REST API in the{' '}
              <code>Authorization: Token &lt;token&gt;</code> header.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the Orca API token
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register an <strong>orca-tenant</strong> component and attach the credential. Leave the host as{' '}
              <code>api.orcasecurity.io</code> for US tenants; EU tenants use{' '}
              <code>api.eu.orcasecurity.io</code>. You can also set the <strong>API Endpoint</strong> app
              setting instead of a per-connection host.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
