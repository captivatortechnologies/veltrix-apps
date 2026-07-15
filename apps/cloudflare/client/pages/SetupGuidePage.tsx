import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const SCOPES = [
  'DNS Edit',
  'Zone WAF Edit',
  'Single Redirect Edit',
  'Transform Rules Edit',
  'Access: Apps & Policies',
  'Zero Trust Edit',
  'Account Filter Lists',
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
              In the Cloudflare dashboard, go to <strong>My Profile &gt; API Tokens</strong> and create
              a <strong>scoped API token</strong>. Grant it the permissions for what this app manages:
            </p>
            <div>
              {SCOPES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Prefer a scoped token over the Global API Key — it can be limited to specific zones,
              accounts, permissions and IPs, and can be rotated.
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
                <strong>API token</strong> → the Cloudflare API token
              </li>
            </ul>
            <p>
              The app sends it as <code>Authorization: Bearer …</code> to{' '}
              <code>https://api.cloudflare.com/client/v4</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & settings',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>cloudflare-zone</strong> component whose hostname is the zone (apex){' '}
              <strong>domain</strong> (e.g. <code>example.com</code>) and attach the credential. The app
              resolves the <strong>zone id</strong> and its owning <strong>account id</strong>{' '}
              automatically via <code>GET /zones?name=…</code>.
            </p>
            <p>
              For account-scoped types (Access, Gateway, Lists) with no zone registered, set the{' '}
              <strong>Account ID</strong> app setting.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
