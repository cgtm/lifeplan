#!/bin/bash
# lp — lifeplan service manager

PLIST="$HOME/Library/LaunchAgents/com.cam.lifeplan.plist"
LOG="$(dirname "$0")/data/server.log"
BACKUP="$(dirname "$0")/data/backup.sh"

case "${1:-help}" in
  start)
    launchctl load "$PLIST"
    sleep 1
    curl -s http://localhost:3131/api/dashboard > /dev/null && echo "lifeplan running at http://localhost:3131" || echo "Failed to start"
    ;;
  stop)
    launchctl unload "$PLIST"
    echo "lifeplan stopped"
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/com.cam.lifeplan"
    sleep 1
    curl -s http://localhost:3131/api/dashboard > /dev/null && echo "lifeplan restarted" || echo "Failed to restart"
    ;;
  status)
    if launchctl list | grep -q lifeplan 2>/dev/null; then
      echo "lifeplan is running"
      curl -s -o /dev/null -w "  HTTP: %{http_code}\n" http://localhost:3131/ 2>/dev/null || echo "  Server not responding"
    else
      echo "lifeplan is not running"
    fi
    ;;
  logs)
    tail -f "$LOG"
    ;;
  backup)
    "$BACKUP" "$2"
    ;;
  serve)
    cd "$(dirname "$0")/app" && python3 server.py
    ;;
  prompts)
    cd "$(dirname "$0")" && python3 -m app.generate_prompts
    ;;
  *)
    echo "Usage: lp <command>"
    echo ""
    echo "  start     Start the service"
    echo "  stop      Stop the service"
    echo "  restart   Restart the service"
    echo "  status    Check if it's running"
    echo "  logs      Tail the server log"
    echo "  backup    Backup the database (optional: lp backup <label>)"
    echo "  serve     Run in foreground (for debugging)"
    echo "  prompts   Manually run prompt generation"
    ;;
esac
