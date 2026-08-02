import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Firewall aliases']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'install-package',
      label: '1. Install the REST API package',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              <strong>pfSense CE and Plus do not ship a REST API.</strong> This app talks to the
              widely-used, independently maintained third-party package{' '}
              <strong>pfSense-pkg-RESTAPI</strong> (formerly known as{' '}
              <code>jaredhendrickson13/pfsense-api</code>) — a real, separate install step on the firewall,
              not something already running.
            </p>
            <p>
              On the firewall's webConfigurator, go to <strong>System &gt; Package Manager &gt; Available
              Packages</strong>, search for <strong>&quot;RESTAPI&quot;</strong> and install it. (It can
              also be installed from the shell with <code>pkg-static add</code> against a release asset —
              see{' '}
              <a href="https://pfrest.org/" target="_blank" rel="noreferrer">
                pfrest.org
              </a>{' '}
              for current instructions.) This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Until the package is installed, every request this app makes will fail with an HTTP 404 —
              that is the signal to come back and finish this step.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'auth',
      label: '2. Choose an auth method',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>The REST API package supports two credential-friendly auth methods, either works:</p>
            <ul>
              <li>
                <strong>API key</strong> (recommended) — in the webConfigurator, go to{' '}
                <strong>System &gt; REST API &gt; Keys</strong> and generate a key. It carries the
                privileges of the user that generated it.
              </li>
              <li>
                <strong>Username + password</strong> — a LOCAL webConfigurator administrator account (LDAP
                and RADIUS-backed accounts are not supported for this). This app mints a short-lived JWT
                (default 1 hour) from that username/password on every deploy — no manual token management
                needed.
              </li>
            </ul>
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
            <p>Store your chosen auth method as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API key</strong> → the &quot;API key&quot; (token) field
              </li>
              <li>
                <strong>Username + password</strong> → the webConfigurator username in &quot;Username&quot;
                and its password in &quot;Password&quot;
              </li>
            </ul>
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
              Under <strong>Connections</strong>, add the firewall's hostname and HTTPS port (default 443
              — the REST API package shares the webConfigurator's listener), e.g.{' '}
              <code>fw.example.com</code>, and attach the credential. Registering a connection also creates
              the <code>pfsense</code> deploy target used by the pipeline.
            </p>
            <p>
              pfSense ships a <strong>self-signed certificate</strong> on the webConfigurator by default —
              TLS verification is off unless you turn on the app's{' '}
              <strong>&quot;Verify TLS certificate&quot;</strong> setting (do so once a CA-signed
              certificate is installed).
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
