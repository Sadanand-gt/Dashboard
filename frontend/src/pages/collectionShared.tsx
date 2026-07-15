import Box from '@mui/material/Box'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import TableCell from '@mui/material/TableCell'
import TableSortLabel from '@mui/material/TableSortLabel'

// ── Analysis parameters for the collection reports (matches Excel + full set) ──
export const COLLECTION_DIMS = [
  { value: 'business_segment',    label: 'Business Segment'     },
  { value: 'zone_name',           label: 'Zone'                 },
  { value: 'cluster_name',        label: 'Cluster'              },
  { value: 'region_name',         label: 'Region'               },
  { value: 'area_name',           label: 'Unit'                 },
  { value: 'branch_name',         label: 'Branch ID & Name'     },
  { value: 'state_id',            label: 'Branch State'         },
  { value: 'district_id',         label: 'District'             },
  { value: 'prod_classification', label: 'Prod. Classification' },
  // OD Status (Regular/Overdue/NPA/Write-off) deactivated — use OD Movement instead.
  // { value: 'curr_od_status',      label: 'OD Status'            },
  { value: 'dpd_bucket',          label: 'OD Bucket'            },
  { value: 'bucket_movement',     label: 'Bucket Movement'      },
  { value: 'loan_status',         label: 'Loan Status'          },
  { value: 'disb_year',           label: 'Disbursement Year'    },
  { value: 'cycle_no',            label: 'Cycle'                },
  { value: 'purpose_id',          label: 'Purpose ID'           },
  { value: 'facility_id',         label: 'Facility ID'          },
  { value: 'lender_id',           label: 'Lender ID'            },
  { value: 'caste',               label: 'Caste'                },
  { value: 'religion',            label: 'Religion'             },
]

export interface CollectionRow {
  name: string
  name2?: string | null
  loan_count: number
  t1_demand_count: number
  mtd_demand_count: number
  t1_demand: number
  t1_collection: number
  t1_ce: number
  t1_otrr: number
  t1_ftod: number
  mtd_demand: number
  mtd_collection: number
  mtd_ce: number
  mtd_ontime: number
  mtd_otrr: number
  mtd_ftod: number
}

export interface CollectionKpis {
  loan_count: number
  t1_demand_count: number
  mtd_demand_count: number
  t1_demand: number
  t1_collection: number
  t1_ce: number
  t1_otrr: number
  t1_ftod: number
  mtd_demand: number
  mtd_collection: number
  mtd_ce: number
  mtd_ontime: number
  mtd_otrr: number
  mtd_ftod: number
  // PMSD = previous month same day (T-1 comparison)
  pmsd_demand: number
  pmsd_collection: number
  pmsd_ce: number
  // PMTD = previous month to date (MTD comparison)
  pmtd_demand: number
  pmtd_collection: number
  pmtd_ce: number
}

// ── Formatters ────────────────────────────────────────────────────────────────
export function fmtInr(v: number): string {
  if (!v && v !== 0) return '—'
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
export function fmtNum(v: number): string { return (v ?? 0).toLocaleString('en-IN') }
export function fmtPct(v: number): string { return `${(v ?? 0).toFixed(2)}%` }

// ── Consistent INR units ──────────────────────────────────────────────────────
// Pick ONE unit for a whole column/table (from its max) so it never mixes Cr & L.
// The unit label goes in the header; cells are formatted with fmtUnit (no ₹ symbol).
export function inrUnit(values: number[]): { div: number; label: string } {
  const max = Math.max(0, ...values.map((v) => Math.abs(v || 0)))
  if (max >= 1e7) return { div: 1e7, label: '₹ Cr' }
  if (max >= 1e5) return { div: 1e5, label: '₹ L' }
  return { div: 1, label: '₹' }
}
export function fmtUnit(v: number, div: number): string {
  if (v == null || (!v && v !== 0)) return '—'
  if (div === 1) return (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
  return (v / div).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── DPD bucket display order (Regular → 360+) ─────────────────────────────────
export const BUCKET_ORDER = ['Regular', '1 - 30', '31 - 60', '61 - 90', '91 - 180', '181 - 360', '360 +']
const _BUCKET_RANK: Record<string, number> = Object.fromEntries(BUCKET_ORDER.map((b, i) => [b, i]))
export function bucketRank(name: string): number { return _BUCKET_RANK[name] ?? 99 }

export function ceColor(v: number): string {
  if (v >= 95) return '#16A34A'
  if (v >= 85) return '#D97706'
  return '#DC2626'
}

// ── Inline dimension select ─────────────────────────────────────────────────
export function DimSelect({
  label, value, options, onChange, minWidth = 148,
}: {
  label: string; value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void; minWidth?: number
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
      <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{label}</Box>
      <FormControl size="small" sx={{ minWidth }}>
        <Select value={value} onChange={(e) => onChange(e.target.value)} displayEmpty
          sx={{ fontSize: '0.74rem', height: 26, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(0,0,0,0.15)' } }}>
          {options.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.74rem' }}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}

// ── Sortable table header cell ────────────────────────────────────────────────
export function SortCell({
  label, field, active, dir, onSort, align = 'left',
}: {
  label: string; field: keyof CollectionRow; active: boolean
  dir: 'asc' | 'desc'; onSort: (f: keyof CollectionRow) => void; align?: 'left' | 'right'
}) {
  return (
    <TableCell align={align} sx={{ whiteSpace: 'nowrap' }}>
      <TableSortLabel active={active} direction={active ? dir : 'desc'} onClick={() => onSort(field)}
        sx={{ color: '#1E40AF !important', '& .MuiTableSortLabel-icon': { color: '#1565C0 !important' } }}>
        {label}
      </TableSortLabel>
    </TableCell>
  )
}
