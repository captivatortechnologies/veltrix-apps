import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'barracuda-waf',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/barracuda-waf/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/barracuda-waf/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/barracuda-waf/connections', label: 'Connections', icon: 'link' },
  ],
}
