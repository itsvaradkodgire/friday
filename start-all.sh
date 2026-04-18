#!/bin/bash

# Start Playwright MCP server in background
echo "Starting Playwright MCP Server..."
npx @playwright/mcp@latest --port 8931 --browser=chrome --config=playwright-mcp.config.json &
MCP_PID=$!

# Wait for MCP server to be ready
sleep 3

# Start Presenter App
echo "Starting Presenter App..."
cd presenter-app && npm start

# When presenter app exits, kill MCP server
kill $MCP_PID 2>/dev/null
