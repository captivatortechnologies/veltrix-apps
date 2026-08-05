import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Roles',
  'GitHub connectors',
  'Trusted clusters',
  'Machine ID bots',
  'Databases',
  'Discovery configs',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'user',
      label: '1. Automation user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a dedicated local Teleport user for this app (e.g. <code>veltrix-automation</code>)
              with a role granting the resources it manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Enroll a <strong>TOTP</strong> device for this user (WebAuthn cannot be satisfied
              headlessly) - <code>tctl users add</code> followed by a TOTP enrollment via <code>tsh</code>,
              or through the Web UI. Note the base32 TOTP seed at enrollment time; some flows only
              show it once.
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
            <p>Store the automation user's credentials as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> - the Teleport username
              </li>
              <li>
                <strong>API token</strong> - a JSON bundle pairing the password with the TOTP seed:{' '}
                <code>{'{"password": "...", "totpSecret": "<base32 seed>"}'}</code>
              </li>
            </ul>
            <p>
              On every request the app logs in via <code>POST /v1/webapi/sessions/web</code> (the same
              call the Teleport Web UI's own login form makes), computing the current TOTP code from
              the seed locally.
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
              Register a <strong>teleport-cluster</strong> component whose hostname is your Teleport
              Proxy address (e.g. <code>teleport.example.com:443</code>), attach the credential. For
              cluster-scoped configuration types (Machine ID Bots, Databases, Discovery Config), the
              app auto-detects the root cluster's name via <code>GET /v1/webapi/sites</code> - set the{' '}
              <strong>Cluster Name</strong> app setting only to target a specific leaf cluster.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Note: editing a built-in preset role (<code>access</code>, <code>editor</code>,{' '}
              <code>auditor</code>) updates it in place.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
