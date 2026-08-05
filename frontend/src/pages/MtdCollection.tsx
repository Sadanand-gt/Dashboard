import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Skeleton from '@mui/material/Skeleton'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'
import {
  COLLECTION_DIMS, DimSelect, SortCell, fmtInr, fmtNum, fmtPct, ceColor,
  inrUnit, fmtUnit, bucketRank,
  type CollectionRow, type CollectionKpis,
} from './collectionShared'
import { TrendSection } from '../components/TrendSection'

export function MtdCollection() {
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [sortField, setSortField] = useState<keyof CollectionRow>('mtd_demand')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [includeWO, setIncludeWO] = useState(true)

  const slicer = useSlicerParams()
  const params = useMemo(() => ({
    ...slicer, ...(includeWO ? {} : { portfolio: 'without' }),
  }), [slicer, includeWO])
  const tableParams = useMemo(() => ({
    ...params, group_by: ap1, ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
  }), [params, ap1, ap2])

  const { data: kpis, isLoading: kpiLoading } = useQuery<CollectionKpis>({
    queryKey: ['coll-kpis', params],
    queryFn: () => api.get('/api/collection/kpis', { params }).then((r) => r.data),
  })
  const { data: rows = [], isLoading: tableLoading } = useQuery<CollectionRow[]>({
    queryKey: ['coll-mtd-group', tableParams],
    queryFn: () => api.get('/api/collection/group-summary', { params: tableParams }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['coll-refresh'],
    queryFn: () => api.get('/api/collection/refresh').then((r) => r.data),
  })

  const handleSort = (f: keyof CollectionRow) => {
    if (f === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortField(f); setSortDir('desc') }
  }
  const sortedRows = useMemo(() => {
    const body = rows.filter((r) => r.name !== 'Grand Total')
    const grand = rows.find((r) => r.name === 'Grand Total')
    if (ap1 === 'dpd_bucket') {
      body.sort((a, b) => bucketRank(a.name) - bucketRank(b.name))  // canonical OD Bucket order
    } else {
      body.sort((a, b) => {
        const av = a[sortField], bv = b[sortField]
        if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
        return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
      })
    }
    return grand ? [...body, grand] : body
  }, [rows, sortField, sortDir, ap1])
  // One INR unit for the whole table so amounts read consistently (never mix Cr & L).
  const amtUnit = useMemo(
    () => inrUnit(rows.flatMap((r) => [r.mtd_demand, r.mtd_collection, r.mtd_ontime])),
    [rows])

  const ap1Label = COLLECTION_DIMS.find((o) => o.value === ap1)?.label ?? ''
  const ap2Label = COLLECTION_DIMS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none'

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>MTD Collection</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={COLLECTION_DIMS} onChange={setAp1} minWidth={170} />
        <DimSelect label="AP #2" value={ap2} options={[{ value: 'none', label: '— None —' }, ...COLLECTION_DIMS]} onChange={setAp2} minWidth={170} />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Portfolio</Box>
          <ToggleButtonGroup value={includeWO ? 'with' : 'without'} exclusive size="small"
            onChange={(_, v) => { if (v !== null) setIncludeWO(v === 'with') }} sx={{ height: 26 }}>
            <ToggleButton value="with" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>With W/O</ToggleButton>
            <ToggleButton value="without" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>Excl. W/O</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Month-to-date as of (T-1)" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>MTD as of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* KPI cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="MTD Demand" value={kpis ? fmtInr(kpis.mtd_demand) : '—'} sub={kpis ? `${fmtNum(kpis.mtd_demand_count)} loans due` : ''} variant="default" loading={kpiLoading} />
        <KpiCard label="MTD Collection" value={kpis ? fmtInr(kpis.mtd_collection) : '—'} variant="green" loading={kpiLoading} />
        <KpiCard label="MTD CE %" value={kpis ? fmtPct(kpis.mtd_ce) : '—'} sub={kpis ? `PMTD: ${fmtPct(kpis.pmtd_ce)}` : ''} variant={kpis && kpis.mtd_ce >= 95 ? 'green' : kpis && kpis.mtd_ce >= 85 ? 'amber' : 'red'} loading={kpiLoading} />
        <KpiCard label="On-Time" value={kpis ? fmtInr(kpis.mtd_ontime) : '—'} sub="paid on/before due date" variant="default" loading={kpiLoading} />
        <KpiCard label="OTRR %" value={kpis ? fmtPct(kpis.mtd_otrr) : '—'} sub="on-time / demand" variant={kpis && kpis.mtd_otrr >= 95 ? 'green' : kpis && kpis.mtd_otrr >= 85 ? 'amber' : 'red'} loading={kpiLoading} />
        <KpiCard label="# FTOD" value={kpis ? fmtNum(kpis.mtd_ftod) : '—'} sub="first-time OD" variant={kpis && kpis.mtd_ftod > 0 ? 'red' : 'green'} loading={kpiLoading} />
      </Box>

      {/* Table */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
            MTD Collection — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>Amounts in {amtUnit.label} &nbsp;|&nbsp; CE% = Collection ÷ Demand &nbsp;|&nbsp; OTRR% = On-Time ÷ Demand</Box>
        </Box>
        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={36} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: hasAp2 ? 940 : 800 }}>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)' } }}>
                  <SortCell label={ap1Label} field="name" active={sortField === 'name'} dir={sortDir} onSort={handleSort} />
                  {hasAp2 && <SortCell label={ap2Label} field="name2" active={sortField === 'name2'} dir={sortDir} onSort={handleSort} />}
                  <SortCell label="Demand" field="mtd_demand" active={sortField === 'mtd_demand'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="Collection" field="mtd_collection" active={sortField === 'mtd_collection'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="MTD CE %" field="mtd_ce" active={sortField === 'mtd_ce'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="On-Time" field="mtd_ontime" active={sortField === 'mtd_ontime'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="OTRR %" field="mtd_otrr" active={sortField === 'mtd_otrr'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="# FTOD" field="mtd_ftod" active={sortField === 'mtd_ftod'} dir={sortDir} onSort={handleSort} align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((row, i) => {
                  const isGrand = row.name === 'Grand Total'
                  return (
                    <TableRow key={i} sx={isGrand ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } } : { '&:hover': { background: '#F8FAFF' } }}>
                      <TableCell>{row.name}</TableCell>
                      {hasAp2 && <TableCell sx={{ color: '#475569' }}>{row.name2 ?? '—'}</TableCell>}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtUnit(row.mtd_demand, amtUnit.div)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtUnit(row.mtd_collection, amtUnit.div)}</TableCell>
                      <TableCell align="right"><CeChip v={row.mtd_ce} /></TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap', color: '#64748B' }}>{fmtUnit(row.mtd_ontime, amtUnit.div)}</TableCell>
                      <TableCell align="right"><CeChip v={row.mtd_otrr} /></TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{fmtNum(row.mtd_ftod)}</TableCell>
                    </TableRow>
                  )
                })}
                {sortedRows.length === 0 && (
                  <TableRow><TableCell colSpan={hasAp2 ? 8 : 7} align="center" sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>No demand this month for this selection.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      <TrendSection title="Trend — Collection Efficiency"
        portfolio={includeWO ? 'with' : 'excl'} ap1={ap1} ap2={ap2}
        measures={[{ key: 'ce_pct', label: 'Monthly CE %', format: 'pct' }, { key: 'reg_ce_pct', label: 'Regular Bucket CE %', format: 'pct' }]} />

    </Box>
  )
}

function CeChip({ v }: { v: number }) {
  const c = ceColor(v)
  return <Chip label={fmtPct(v)} size="small" sx={{ height: 18, fontSize: '0.68rem', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, background: `${c}18`, color: c, border: `1px solid ${c}40`, '& .MuiChip-label': { px: 0.75 } }} />
}
