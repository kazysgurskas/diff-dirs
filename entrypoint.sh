#!/bin/bash
set -e

# Log current version
echo "Starting GitOps Diff Split Comments action"
echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# Run the Node.js script
node /app/src/index.js
