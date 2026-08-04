-- ============================================================================
-- Ananya MIS — write-off columns for the Trend report's Portfolio toggle
-- Database: ananya_mis_dashboard   Schema: public   Run as the table owner.
--
-- Why: rpt_trend_full currently stores POS/PAR EXCLUDING written-off loans, so
-- the "With W/O / Excl. W/O" portfolio toggle cannot work on the trend.
-- These two columns carry the write-off book per month; the dashboard then
-- derives "With W/O" the same way the live report does (a written-off loan
-- sits in POS and in EVERY PAR band).
--
-- Safe to re-run (IF NOT EXISTS). No data is moved or deleted.
-- ============================================================================

ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS wo_loans_eom BIGINT;
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS wo_pos_eom   NUMERIC(18,2);
