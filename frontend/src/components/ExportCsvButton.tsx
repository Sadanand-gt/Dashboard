import { useState } from 'react'
import Button from '@mui/material/Button'
import Tooltip from '@mui/material/Tooltip'
import DownloadIcon from '@mui/icons-material/Download'
import { useAuthStore } from '../store/authStore'

/**
 * CSV export, gated on the per-user `can_export` privilege.
 *
 * The button RENDERS NOTHING unless the signed-in user has been granted export.
 * That is deliberate: downloading turns dashboard data into a file that leaves
 * every access control behind, so it is off for everyone until an admin turns it
 * on in User Management. A user without the grant sees no button at all rather
 * than a disabled one — a disabled control advertises a capability and invites
 * a request; absence is quieter and just as honest.
 *
 * This is a UI gate on data the user is already permitted to see (the rows come
 * from an API response that has already been scope-filtered), so it is a
 * usage control, not a security boundary.
 */
export function ExportCsvButton({
  rows, filename, columns, disabled, fetchRows, label,
}: {
  rows: Record<string, any>[]
  filename: string
  /** [key, header] pairs — controls both column order and header text. */
  columns: [string, string][]
  disabled?: boolean
  /**
   * Optional lazy source. When given, the rows are fetched ON CLICK instead of
   * being held in the page. Loan-wise exports run to tens of thousands of rows;
   * pulling that on every render would cost every export-privileged user a large
   * download they may never ask for.
   */
  fetchRows?: () => Promise<Record<string, any>[]>
  label?: string
}) {
  const user = useAuthStore((s) => s.user)
  const [busy, setBusy] = useState(false)
  if (!user?.can_export) return null

  const download = async () => {
    let data = rows
    if (fetchRows) {
      setBusy(true)
      try {
        data = await fetchRows()
      } finally {
        setBusy(false)
      }
    }
    if (!data.length) return
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v)
      // Quote when the value could break the row, and double any inner quotes.
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const head = columns.map(([, h]) => esc(h)).join(',')
    const body = data.map((r) => columns.map(([k]) => esc(r[k])).join(',')).join('\n')
    // BOM so Excel opens UTF-8 (₹ and Indian names) without mangling it.
    const blob = new Blob([`﻿${head}\n${body}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Tooltip title={fetchRows
      ? 'Download the current selection loan-wise as CSV'
      : `Download ${rows.length.toLocaleString('en-IN')} rows as CSV`}>
      <span>
        <Button
          size="small"
          variant="outlined"
          startIcon={<DownloadIcon sx={{ fontSize: 16 }} />}
          onClick={download}
          disabled={disabled || busy || (!fetchRows && rows.length === 0)}
          sx={{ fontSize: '0.7rem', textTransform: 'none', borderColor: '#E2E8F0',
                color: '#0F172A', px: 1.5,
                '&:hover': { borderColor: '#CBD5E1', bgcolor: '#F8FAFC' } }}
        >
          {busy ? 'Preparing…' : (label ?? 'Export CSV')}
        </Button>
      </span>
    </Tooltip>
  )
}
