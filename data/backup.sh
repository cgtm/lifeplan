#!/bin/bash
# Database backup script
# Usage: ./backup.sh [label]
# Creates a timestamped copy of lifeplan.db in data/backups/

DIR="$(cd "$(dirname "$0")" && pwd)"
DB="$DIR/lifeplan.db"
BACKUP_DIR="$DIR/backups"

if [ ! -f "$DB" ]; then
  echo "Error: database not found at $DB"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LABEL="${1:+_$1}"
BACKUP="$BACKUP_DIR/lifeplan_${TIMESTAMP}${LABEL}.db"

# Use sqlite3 .backup for a safe copy (handles WAL mode correctly)
sqlite3 "$DB" ".backup '$BACKUP'"

SIZE=$(du -h "$BACKUP" | cut -f1)
COUNT=$(ls "$BACKUP_DIR"/lifeplan_*.db 2>/dev/null | wc -l | tr -d ' ')
echo "Backed up to: $BACKUP ($SIZE)"
echo "Total backups: $COUNT"

# Prune backups older than 30 days
PRUNED=$(find "$BACKUP_DIR" -name "lifeplan_*.db" -mtime +30 -delete -print | wc -l | tr -d ' ')
if [ "$PRUNED" -gt 0 ]; then
  echo "Pruned $PRUNED backup(s) older than 30 days"
fi
