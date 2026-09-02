#!/bin/bash
# lp — lifeplan service manager

PLIST="$HOME/Library/LaunchAgents/com.cam.lifeplan.plist"
WORKER_PLIST="$HOME/Library/LaunchAgents/com.cam.lifeplan-worker.plist"
LOG="$(dirname "$0")/data/server.log"
WORKER_LOG="$(dirname "$0")/data/worker.log"
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
    if launchctl list | grep -q "com.cam.lifeplan$" 2>/dev/null; then
      echo "lifeplan is running"
      curl -s -o /dev/null -w "  HTTP: %{http_code}\n" http://localhost:3131/ 2>/dev/null || echo "  Server not responding"
    else
      echo "lifeplan is not running"
    fi
    ;;
  logs)
    tail -f "$LOG"
    ;;
  worker)
    case "${2:-status}" in
      start)
        launchctl load "$WORKER_PLIST"
        echo "worker loaded"
        ;;
      stop)
        launchctl unload "$WORKER_PLIST"
        echo "worker unloaded"
        ;;
      restart)
        launchctl kickstart -k "gui/$(id -u)/com.cam.lifeplan-worker"
        echo "worker restarted"
        ;;
      status)
        launchctl list | grep lifeplan-worker || echo "worker not loaded"
        ;;
      logs)
        tail -f "$WORKER_LOG"
        ;;
      *)
        echo "Usage: lp worker <start|stop|restart|status|logs>"
        ;;
    esac
    ;;
  restart-all)
    launchctl kickstart -k "gui/$(id -u)/com.cam.lifeplan"
    launchctl kickstart -k "gui/$(id -u)/com.cam.lifeplan-worker"
    sleep 1
    curl -s http://localhost:3131/api/dashboard > /dev/null && echo "lifeplan + worker restarted" || echo "Server not responding after restart"
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
  pull-db)
    DEPLOY_CONF="$(dirname "$0")/deploy.conf"
    if [[ ! -f "$DEPLOY_CONF" ]]; then
      echo "ERROR: $DEPLOY_CONF not found."
      echo "Copy deploy.conf.example to deploy.conf and fill in your real server details."
      exit 1
    fi
    # shellcheck source=/dev/null
    source "$DEPLOY_CONF"
    : "${SERVER_HOST:?SERVER_HOST not set in deploy.conf}"
    : "${SERVER_USER:?SERVER_USER not set in deploy.conf}"
    : "${REMOTE_BASE:?REMOTE_BASE not set in deploy.conf}"
    LOCAL_DB="$(dirname "$0")/data/lifeplan.db"
    echo "Pulling database from droplet..."
    echo "  Local backup: ${LOCAL_DB}.before-pull"
    cp "$LOCAL_DB" "${LOCAL_DB}.before-pull"
    rsync -az "${SERVER_USER}@${SERVER_HOST}:${REMOTE_BASE}/data/lifeplan.db" "$LOCAL_DB"
    echo "  Done. Local database updated from droplet."
    ;;
  deploy)
    shift
    cd "$(dirname "$0")" && bash deploy.sh "$@"
    ;;
  *)
    echo "Usage: lp <command>"
    echo ""
    echo "  start         Start the local server"
    echo "  stop          Stop the local server"
    echo "  restart       Restart the local server"
    echo "  status        Check if the server is running"
    echo "  logs          Tail the server log"
    echo "  worker <cmd>  Manage the background worker (start|stop|restart|status|logs)"
    echo "  restart-all   Restart both server and worker"
    echo "  backup        Backup the database (optional: lp backup <label>)"
    echo "  serve         Run the server in foreground (for debugging)"
    echo "  prompts       Manually run prompt generation"
    echo "  pull-db       Download the droplet database (backs up local first)"
    echo "  deploy        Deploy to droplet (code only by default)"
    echo "                  lp deploy --with-db --force  overwrites prod db (requires --force)"
    ;;
esac
