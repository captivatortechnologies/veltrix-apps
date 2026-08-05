import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Internet Firewall rules & sections',
  'WAN Firewall rules & sections',
  'Application Control rules',
  'TLS Inspection rules',
  'Anti-Malware file-hash rules',
  'Custom Applications',
  'Network Ranges',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-key',
      label: '1. API Key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Cato Management Application, go to <strong>Administration &gt; API Keys</strong>{' '}
              and click <strong>+ New</strong>. Scope the key's role to what this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>Copy the generated API key - it is shown once.</p>
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
            <p>Store the API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> - the Cato API Key
              </li>
            </ul>
            <p>
              Every request sends it as the <code>x-api-key</code> header, alongside{' '}
              <code>x-account-id</code> and an <code>accountId</code> GraphQL argument identifying your
              tenant.
            </p>
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
              Register a <strong>cato-account</strong> component whose hostname is your Cato{' '}
              <strong>Account ID</strong> (Cato Management Application, top-right account switcher, or{' '}
              <strong>Administration &gt; API Keys</strong>), and attach the credential.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Internet/WAN Firewall, Application Control and TLS Inspection rules are staged
              into your own private draft revision and only take effect once deploy publishes it -
              exactly like Cato's own change-management workflow.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
