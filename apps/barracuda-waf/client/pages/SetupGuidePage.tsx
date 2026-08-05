import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Basic Security',
  'IP Reputation',
  'DDoS Allow List',
  'Header Allow/Deny',
  'Parameter Protection',
  'URL Protection',
  'Traffic Rules',
  'Rate Control Pools',
  'Response Pages',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'admin',
      label: '1. Admin account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              You need a Barracuda Cloud Control admin account (or a role-based admin scoped to the
              account) that can manage the target Application. Its email and password authenticate every
              API call — exchanged for a short-lived session token via <code>POST /api_login/</code> and
              sent as the <code>auth-api</code> header — and drive:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
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
            <p>Store the admin credentials as a Veltrix connection (Username &amp; password auth):</p>
            <ul>
              <li>
                <strong>Admin email</strong> (Username) → the admin account's full email address
              </li>
              <li>
                <strong>Password</strong> → the admin account password
              </li>
            </ul>
            <p>
              If this account is a Barracuda partner/MSP account acting on behalf of a managed
              sub-account, set the <strong>Account ID (MSP, optional)</strong> app setting to the target
              sub-account's id.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & Application',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>barracuda-waf</strong> component whose hostname is the{' '}
              <strong>exact Application name</strong> shown under Applications in the WAF-as-a-Service
              console (e.g. <code>my-app.example.com</code>) and attach the credential. Every
              configuration type in this app targets that one Application, addressed as{' '}
              <code>/applications/&lt;that-name&gt;/...</code> by the underlying API.
            </p>
            <p>Register one component per Application you want to manage as code.</p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
