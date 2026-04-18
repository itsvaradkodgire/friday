#!/bin/bash

echo "Starting Playwright MCP Server..."
npx @playwright/mcp@latest --port 8931 --browser=chrome --config=playwright-mcp.config.json
