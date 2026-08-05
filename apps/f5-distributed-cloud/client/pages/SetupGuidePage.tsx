import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'HTTP Load Balancers',
  'TCP Load Balancers',
  'Origin Pools',
  'Health Checks',
  'App Firewall (WAF) Policies',
  'Service Policies',
  'Malicious User Mitigation',
  'Network Policies',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. API Token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the F5 Distributed Cloud Console, go to{' '}
              <strong>Administration &gt; Personal Management &gt; Credentials</strong>, click{' '}
              <strong>Add Credentials</strong>, and choose API Credential Type <strong>API Token</strong>.
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
              Grant the credential's owning user a role covering these object types (e.g.{' '}
              <strong>ves-io-admin-role</strong>, or a narrower custom RBAC role). Copy the generated{' '}
              <strong>API Token</strong> - it is shown once.
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
            <p>Store the API Token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> - the F5 XC API Token value
              </li>
            </ul>
            <p>
              An API Token is a single bearer secret (no separate username) - the app sends it as{' '}
              <code>Authorization: APIToken &lt;token&gt;</code> on every request.
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
              Register an <strong>f5xc-namespace</strong> component whose hostname is your tenant's{' '}
              <strong>Console hostname</strong> (e.g. <code>acmecorp.console.ves.volterra.io</code>,
              shown in the browser address bar when logged into the F5 XC Console), attach the
              credential, and set the app's <strong>F5 XC Namespace</strong> setting to the namespace
              this connection manages (defaults to <code>default</code>) - a namespace is a
              tenant-internal partition, and this app manages exactly one namespace per connection.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Objects that reference each other by name (an HTTP Load Balancer's App
              Firewall, an Origin Pool's Health Check) are resolved live from your connected
              namespace via a picker.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
