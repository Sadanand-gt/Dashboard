import Paper from '@mui/material/Paper'
import Box from '@mui/material/Box'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'

export interface Column {
  key: string
  label: string
  align?: 'left' | 'right'
  format?: (v: unknown, row: Record<string, unknown>) => string
}

interface Props {
  title: string
  columns: Column[]
  rows: Record<string, unknown>[]
  maxHeight?: number
  emptyText?: string
}

/** Dark-themed, scrollable report table matching the dashboard style. */
export function ReportTable({ title, columns, rows, maxHeight = 480, emptyText }: Props) {
  return (
    <Paper>
      <Box
        className="px-4 py-3 font-semibold text-sm border-b flex items-center justify-between"
        sx={{ borderColor: 'rgba(46,125,204,0.15)' }}
      >
        <span>{title}</span>
        <span className="text-xs font-normal" style={{ color: '#4A6B8A' }}>
          {rows.length.toLocaleString('en-IN')} rows
        </span>
      </Box>
      {rows.length === 0 ? (
        <Box className="px-4 py-10 text-center text-sm" sx={{ color: '#4A6B8A' }}>
          {emptyText ?? 'No data — run the pipeline to populate this report.'}
        </Box>
      ) : (
        <Box sx={{ maxHeight, overflow: 'auto' }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    align={c.align ?? 'left'}
                    sx={{
                      background: '#0D1E35', color: '#7FA8D4', fontWeight: 600,
                      fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em',
                      borderBottom: '1px solid rgba(46,125,204,0.2)', whiteSpace: 'nowrap',
                    }}
                  >
                    {c.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i} hover>
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      align={c.align ?? 'left'}
                      sx={{
                        color: '#E8F0FB', fontSize: '0.78rem',
                        borderBottom: '1px solid rgba(46,125,204,0.08)', whiteSpace: 'nowrap',
                      }}
                    >
                      {c.format ? c.format(row[c.key], row) : String(row[c.key] ?? '')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Paper>
  )
}
