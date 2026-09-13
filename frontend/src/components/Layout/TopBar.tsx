import Box from '@mui/material/Box'
import { useLocation } from 'react-router-dom'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard':               'Executive Summary',
  '/dashboard/aum':           'Current Outstanding',
  '/dashboard/aum-live':      'AUM — DPD Detail',
  '/dashboard/ageing':        'Ageing Analysis',
  '/dashboard/od-status':     'OD Status',
  '/dashboard/dq-category':   'DQ Category',
  '/dashboard/od-slippage':   'OD Slippage',
  '/dashboard/daily':         'T-1 Collection',
  '/dashboard/mtd':           'MTD Collection',
  '/dashboard/cashless':      'Cashless Collection',
  '/dashboard/disbursement':  'Disbursement',
  '/dashboard/pos-par':       'POS & Portfolio at Risk',
  '/dashboard/par60-collection': 'PAR 60 Collection',
  '/dashboard/bucket-movement':'Bucket Movement',
  '/dashboard/case-movement': 'Case Movement',
  '/dashboard/origination-funnel': 'Origination Funnel',
  '/dashboard/writeoff':      'Write-Off Portfolio',
  '/dashboard/trend':         'Monthly Trend',
  '/dashboard/vintage':       'Vintage Curve',
  '/dashboard/aml':           'AML Risk Category',
  '/dashboard/ots':           'One-Time Settlement',
  '/dashboard/portfolio-cuts':'Portfolio Cuts',
  '/dashboard/credit-bureau': 'Credit Bureau & Sourcing',
  '/dashboard/admin/users':   'User Management',
}

export function TopBar() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] ?? 'Dashboard'
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  })

  return (
    <Box
      component="header"
      className="flex items-center justify-between px-6 py-3"
      sx={{
        borderBottom: '1px solid rgba(0,0,0,0.07)',
        background: '#FFFFFF',
        minHeight: 52,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      <Box sx={{ fontSize: '0.95rem', fontWeight: 700, color: '#1E293B' }}>{title}</Box>
      <Box sx={{ fontSize: '0.75rem', color: '#94A3B8' }}>{today}</Box>
    </Box>
  )
}
