import { useState, useEffect, useMemo } from 'react'
import Box from '@mui/material/Box'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Close'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'

const MUTED = '#64748B'

/**
 * Loan ID search — a LOOKUP, not an analysis parameter.
 *
 * Grouping by loan_id would render one row per loan (92,769 on Current
 * Outstanding), so it is exposed as a filter instead. The value is passed to the
 * backend as `loan_id`; several ids may be entered comma-separated.
 *
 * Debounced so typing an 8-digit id fires one request, not eight.
 */
export function LoanSearch({ value, onChange, width = 190 }: {
  value: string
  onChange: (v: string) => void
  width?: number
}) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  useEffect(() => {
    const t = setTimeout(() => { if (text !== value) onChange(text.trim()) }, 400)
    return () => clearTimeout(t)
  }, [text])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TextField
      size="small" value={text} placeholder="Loan ID"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') onChange(text.trim()) }}
      sx={{ width, '& .MuiOutlinedInput-root': { height: 28, fontSize: '0.72rem' } }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <SearchIcon sx={{ fontSize: 15, color: MUTED }} />
          </InputAdornment>
        ),
        endAdornment: text ? (
          <InputAdornment position="end">
            <IconButton size="small" onClick={() => { setText(''); onChange('') }}>
              <ClearIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </InputAdornment>
        ) : null,
      }}
    />
  )
}

const PAGE_SIZES = [50, 100, 250, 500]

/**
 * Client-side paging for an already-fetched AP table.
 *
 * THE GRAND TOTAL IS NEVER PAGED. A row named 'Grand Total' is lifted out
 * before slicing and handed back separately, so it always reflects the FULL
 * filtered set rather than the visible page — a total that silently described
 * one page would be exactly the kind of quiet wrongness these reports exist to
 * avoid.
 */
export function usePagedRows<T extends { name?: string }>(rows: T[], pageSize: number, page: number) {
  return useMemo(() => {
    const grand = rows.find((r) => String(r.name) === 'Grand Total')
    const body = rows.filter((r) => String(r.name) !== 'Grand Total')
    const pages = Math.max(1, Math.ceil(body.length / pageSize))
    const safe = Math.min(page, pages - 1)
    return {
      pageRows: body.slice(safe * pageSize, safe * pageSize + pageSize),
      grand, total: body.length, pages, page: safe,
    }
  }, [rows, pageSize, page])
}

/** Footer control: "X–Y of N", page size, prev/next. Renders nothing for one page. */
export function Paginator({ page, pages, total, pageSize, onPage, onPageSize }: {
  page: number; pages: number; total: number; pageSize: number
  onPage: (p: number) => void; onPageSize: (n: number) => void
}) {
  if (total === 0) return null
  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.25, py: 0.6,
               borderTop: '1px solid #E2E8F0', fontSize: '0.72rem', color: MUTED }}>
      <Box>{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</Box>
      <Box sx={{ flex: 1 }} />
      <Box sx={{ whiteSpace: 'nowrap' }}>Rows</Box>
      <Select size="small" value={pageSize} onChange={(e) => { onPageSize(Number(e.target.value)); onPage(0) }}
        sx={{ height: 24, fontSize: '0.72rem' }}>
        {PAGE_SIZES.map((n) => <MenuItem key={n} value={n} sx={{ fontSize: '0.72rem' }}>{n}</MenuItem>)}
      </Select>
      <IconButton size="small" disabled={page <= 0} onClick={() => onPage(page - 1)}
        sx={{ fontSize: '0.72rem' }}>‹</IconButton>
      <Box sx={{ whiteSpace: 'nowrap' }}>{page + 1} / {pages}</Box>
      <IconButton size="small" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}
        sx={{ fontSize: '0.72rem' }}>›</IconButton>
    </Box>
  )
}
