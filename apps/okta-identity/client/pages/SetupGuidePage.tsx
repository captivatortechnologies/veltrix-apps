import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Policies & rules',
  'Groups & rules',
  'Network zones',
  'Authenticators & IdPs',
  'Authorization servers',
  'Apps & assignments',
  'Event & inline hooks',
  'Log streams',
  'ThreatInsight',
  'Device assurance',
  'User types',
  'Custom admin roles & resource sets',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Okta Admin console, go to <strong>Security &gt; API &gt; Tokens</strong> and
              create a token. An Okta API token inherits the permissions of the admin who created it,
              so create it as an admin scoped to what this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>Copy the token value — Okta shows it once.</p>
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
                <strong>API token</strong> → the Okta API token
              </li>
            </ul>
            <p>
              The app authenticates every request with <code>Authorization: SSWS &lt;token&gt;</code>.
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
              Register an <strong>okta-org</strong> component whose hostname is your Okta org domain
              (e.g. <code>dev-12345.okta.com</code> or <code>acme.oktapreview.com</code>) and attach
              the credential.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Note: Okta requires some objects (group rules) to be deactivated before they
              can be changed, and it protects built-in objects (default policies, the Everyone group,
              system network zones) — the app handles both.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
