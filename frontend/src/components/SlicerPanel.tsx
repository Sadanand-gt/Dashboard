import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Badge from '@mui/material/Badge'
import Chip from '@mui/material/Chip'
import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import FilterListIcon from '@mui/icons-material/FilterList'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { api } from '../api/client'
import { useFilterStore } from '../store/filterStore'

// Slicer panel colours — soft grey shell (matches the nav sidebar)
const BG     = '#E2E7EE'
const BORDER = 'rgba(15,23,42,0.10)'
const TEXT   = '#334155'   // slate-700
const MUTED  = '#64748B'   // slate-500
const CHIP_BG = 'rgba(21,101,192,0.10)'
const CHIP_FG = '#1565C0'

interface Slicer      { id: string; label: string; options: string[]; available: boolean }
interface SlicerGroup { label: string; slicers: Slicer[] }
interface FilterOptionsResponse { groups: SlicerGroup[] }

const DEFAULT_EXPANDED = ['Segment & Product', 'Geography', 'Risk / Overdue']

export function SlicerPanel() {
  const { selections, setSelection, clearSlicer, clearAll, panelOpen, setPanelOpen, activeCount } =
    useFilterStore()

  const { data } = useQuery<FilterOptionsResponse>({
    queryKey: ['filter-options'],
    queryFn: () => api.get('/api/filters/options').then((r) => r.data),
  })

  const groups = data?.groups ?? []
  const active = activeCount()

  const activeChips = useMemo(() => {
    const labelById: Record<string, string> = {}
    groups.forEach((g) => g.slicers.forEach((s) => (labelById[s.id] = s.label)))
    return Object.entries(selections).flatMap(([id, vals]) =>
      vals.map((v) => ({ id, label: labelById[id] ?? id, value: v })),
    )
  }, [selections, groups])

  // ── Collapsed strip on right edge ──────────────────────────────────────────
  if (!panelOpen) {
    return (
      <Box
        sx={{
          width: 48,
          flexShrink: 0,
          borderLeft: `1px solid ${BORDER}`,
          background: BG,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          py: 2,
          gap: 1,
        }}
      >
        <Tooltip title="Show filters" placement="left">
          <IconButton size="small" onClick={() => setPanelOpen(true)} sx={{ color: TEXT }}>
            <Badge badgeContent={active} color="error" overlap="circular">
              <FilterListIcon fontSize="small" />
            </Badge>
          </IconButton>
        </Tooltip>
        <Tooltip title="Expand" placement="left">
          <IconButton size="small" onClick={() => setPanelOpen(true)} sx={{ color: MUTED }}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    )
  }

  // ── Expanded panel ──────────────────────────────────────────────────────────
  return (
    <Box
      sx={{
        width: 260,
        flexShrink: 0,
        borderLeft: `1px solid ${BORDER}`,
        background: BG,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          px: 2, py: 1.5, borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FilterListIcon fontSize="small" sx={{ color: TEXT }} />
          <Box sx={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.1em', color: TEXT, textTransform: 'uppercase' }}>
            Filters
          </Box>
          {active > 0 && (
            <Chip
              label={active}
              size="small"
              sx={{ height: 16, fontSize: '0.6rem', bgcolor: CHIP_BG, color: CHIP_FG }}
            />
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {active > 0 && (
            <Tooltip title="Clear all filters">
              <IconButton size="small" onClick={clearAll} sx={{ color: MUTED, '&:hover': { color: TEXT } }}>
                <RestartAltIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Collapse">
            <IconButton size="small" onClick={() => setPanelOpen(false)} sx={{ color: MUTED, '&:hover': { color: TEXT } }}>
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <Box
          sx={{
            display: 'flex', flexWrap: 'wrap', gap: 0.6,
            px: 2, py: 1.2, borderBottom: `1px solid ${BORDER}`,
            maxHeight: 100, overflowY: 'auto', flexShrink: 0,
          }}
        >
          {activeChips.map((c) => (
            <Chip
              key={`${c.id}:${c.value}`}
              label={c.value}
              size="small"
              onDelete={() =>
                setSelection(c.id, (selections[c.id] ?? []).filter((v) => v !== c.value))
              }
              sx={{
                height: 18, fontSize: '0.62rem',
                bgcolor: CHIP_BG, color: CHIP_FG,
                '& .MuiChip-deleteIcon': { color: CHIP_FG, fontSize: 13, opacity: 0.7 },
              }}
            />
          ))}
        </Box>
      )}

      {/* Scrollable slicer groups */}
      <Box sx={{ flex: 1, overflowY: 'auto', py: 0.5 }}>
        {groups.map((group) => (
          <Accordion
            key={group.label}
            defaultExpanded={DEFAULT_EXPANDED.includes(group.label)}
            disableGutters
            elevation={0}
            sx={{
              background: 'transparent',
              '&:before': { display: 'none' },
              borderBottom: `1px solid ${BORDER}`,
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon fontSize="small" sx={{ color: MUTED }} />}
              sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}
            >
              <Box sx={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em', color: TEXT, textTransform: 'uppercase' }}>
                {group.label}
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.5 }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {group.slicers.map((s) => (
                  <SlicerControl
                    key={s.id}
                    slicer={s}
                    value={selections[s.id] ?? []}
                    onChange={(vals) => setSelection(s.id, vals)}
                    onClear={() => clearSlicer(s.id)}
                  />
                ))}
              </Box>
            </AccordionDetails>
          </Accordion>
        ))}
      </Box>
    </Box>
  )
}

function SlicerControl({
  slicer, value, onChange,
}: {
  slicer: Slicer
  value: string[]
  onChange: (v: string[]) => void
  onClear: () => void
}) {
  const disabled = !slicer.available
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
        <Box sx={{ fontSize: '0.68rem', fontWeight: 600, color: disabled ? 'rgba(51,65,85,0.35)' : MUTED }}>
          {slicer.label}
        </Box>
        {disabled && (
          <Box sx={{ fontSize: '0.58rem', fontStyle: 'italic', color: 'rgba(51,65,85,0.3)' }}>
            soon
          </Box>
        )}
      </Box>
      <Autocomplete
        multiple
        size="small"
        disabled={disabled}
        options={slicer.options}
        value={value}
        onChange={(_, v) => onChange(v)}
        limitTags={2}
        disableCloseOnSelect
        renderTags={(vals, getTagProps) =>
          vals.map((option, index) => (
            <Chip
              {...getTagProps({ index })}
              key={option}
              label={option}
              size="small"
              sx={{
                height: 17, fontSize: '0.58rem',
                bgcolor: CHIP_BG, color: CHIP_FG,
                '& .MuiChip-deleteIcon': { color: CHIP_FG, fontSize: 12, opacity: 0.7 },
              }}
            />
          ))
        }
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={disabled ? '—' : value.length ? '' : 'All'}
            variant="outlined"
          />
        )}
        sx={{
          '& .MuiOutlinedInput-root': {
            py: '2px !important',
            fontSize: '0.72rem',
            background: '#FFFFFF',
            color: TEXT,
            minHeight: 30,
          },
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(15,23,42,0.15) !important',
          },
          '& .MuiSvgIcon-root': { color: MUTED },
          '& input::placeholder': { color: 'rgba(51,65,85,0.4)', opacity: 1 },
          '& .MuiAutocomplete-popupIndicator': { color: MUTED },
          '& .MuiAutocomplete-clearIndicator': { color: MUTED },
        }}
        ListboxProps={{
          sx: {
            fontSize: '0.75rem',
            '& .MuiAutocomplete-option': {
              py: '4px',
            },
          },
        }}
      />
    </Box>
  )
}
