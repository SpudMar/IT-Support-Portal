#!/bin/bash
set -e

echo "=== Lotus IT Support Portal Startup ==="
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# 1. Install dependencies
echo "Installing Python dependencies..."
pip install --no-cache-dir -r requirements.txt
if [ $? -ne 0 ]; then
    echo "FATAL: pip install failed"
    exit 1
fi

# 2. Validate critical env vars
REQUIRED_VARS="SHAREPOINT_SITE_ID SHAREPOINT_LIST_ID"
for var in $REQUIRED_VARS; do
    if [ -z "${!var}" ]; then
        echo "WARNING: $var is not set"
    fi
done

# 3. Start the app
echo "Starting Gunicorn with 4 Uvicorn workers..."
exec gunicorn -w 4 -k uvicorn.workers.UvicornWorker \
    --timeout 120 \
    --graceful-timeout 30 \
    --access-logfile - \
    --error-logfile - \
    --log-level info \
    main:app
