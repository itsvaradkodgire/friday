@echo off
start "Playwright MCP" cmd /k "npx @playwright/mcp@latest --port 8931 --browser=chrome --config=playwright-mcp.config.json"
timeout /t 3
start "Presenter App" cmd /k "cd presenter-app && npm start"
