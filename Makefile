PLIST = ~/Library/LaunchAgents/com.cam.lifeplan.plist
LOG   = data/server.log

.PHONY: start stop restart status logs backup serve

start:
	launchctl load $(PLIST)
	@sleep 1
	@curl -s http://localhost:3131/api/dashboard > /dev/null && echo "lifeplan running at http://localhost:3131" || echo "Failed to start"

stop:
	launchctl unload $(PLIST)
	@echo "lifeplan stopped"

restart: stop start

status:
	@launchctl list | grep lifeplan > /dev/null 2>&1 && echo "lifeplan is running" || echo "lifeplan is not running"
	@curl -s -o /dev/null -w "  HTTP: %{http_code}\n" http://localhost:3131/ 2>/dev/null || echo "  Server not responding"

logs:
	tail -f $(LOG)

backup:
	./data/backup.sh

serve:
	cd app && python3 server.py
