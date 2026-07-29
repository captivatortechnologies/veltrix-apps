import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'security-onion',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/security-onion/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/security-onion/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/security-onion/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/security-onion/byol', label: 'BYOL Infrastructure', icon: 'server' },
  ],
}
