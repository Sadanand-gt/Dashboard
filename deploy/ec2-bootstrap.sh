#!/usr/bin/env bash
# =============================================================================
# ec2-bootstrap.sh — EC2 user-data for the MIS pipeline runner.
#
# Paste into "User data" when launching the instance, or run it by hand on a
# fresh box. It gets the machine to the point where install-pipeline-timer.sh
# can run; it deliberately does NOT place credentials.
#
# LAUNCH IT IN ap-south-2 (Hyderabad), the SOURCE region.
#   The run is read-heavy and write-light: it scans millions of rows out of
#   Ananya_app_prod (ap-south-2) and writes a few hundred thousand report rows
#   into ananya_mis_dashboard (ap-south-1). The failures on the laptop are all
#   on the heavy READS, so co-locate with the source and let the small writes
#   cross regions.
#
# t3.medium is enough — the laptop manages ~1h50m on 8 GB — but trend_full
# rebuilds the entire history nightly, so do not go smaller.
#
# SECURITY GROUPS, the thing that bites first:
#   · this instance: outbound 5432 to BOTH RDS instances
#   · each RDS SG: inbound 5432 from this instance's SG
#   Cross-region means no default VPC rule covers it.
# =============================================================================
set -euxo pipefail

REPO_URL="${REPO_URL:-}"          # e.g. https://github.com/<org>/ananya_mis.git
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/ananya_mis

# ── packages ─────────────────────────────────────────────────────────────────
if command -v dnf &>/dev/null; then
  dnf -y update
  dnf -y install git python3.12 python3.12-pip rsync logrotate postgresql16
else
  apt-get update -y
  apt-get install -y git python3.12 python3.12-venv python3-pip rsync logrotate postgresql-client
fi

# ── clock ────────────────────────────────────────────────────────────────────
# The timer fires on Asia/Kolkata and the pipeline anchors everything on
# current_date - 1. A box left on UTC would run against the wrong day near
# midnight IST, which is exactly the kind of off-by-one nobody notices for weeks.
timedatectl set-timezone Asia/Kolkata || true

# ── code ─────────────────────────────────────────────────────────────────────
mkdir -p "$APP_DIR"
if [[ -n "$REPO_URL" ]]; then
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" /tmp/ananya_mis
  rsync -a --exclude '.git' /tmp/ananya_mis/ "$APP_DIR/"
else
  echo "REPO_URL not set — copy the repo into $APP_DIR yourself, then run:"
  echo "    sudo bash $APP_DIR/deploy/install-pipeline-timer.sh"
  exit 0
fi

# ── the rest ─────────────────────────────────────────────────────────────────
bash "$APP_DIR/deploy/install-pipeline-timer.sh"

cat <<'EOF'

=============================================================================
STILL TO DO BY HAND — the box is ready but the pipeline cannot run yet:

  1. credentials
       sudo install -o ananya -g ananya -m 600 /path/to/.env /opt/ananya_mis/.env

  2. prove it can reach BOTH databases before trusting the timer
       psql "host=<replica-host> port=5432 dbname=Ananya_app_prod        user=<u>" -c "select 1"
       psql "host=<report-host>  port=5432 dbname=ananya_mis_dashboard  user=<u>" -c "select 1"

  3. the write-off master check — see deploy/README.md. It should read ~30,661.
     An empty read produces a GREEN run with silently wrong numbers.

  4. first run, watched
       sudo systemctl start ananya-pipeline.service
       sudo journalctl -u ananya-pipeline -f
=============================================================================

EOF
