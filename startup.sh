#!/bin/bash

# 1. Install Dependencies
# This ensures that even if Oryx fails, we have our packages (uvicorn, fastapi, etc.)
echo "Installing dependencies from requirements.txt..."
pip install -r requirements.txt

# 2. Start the App
# We use the same command you had, but now we are sure dependencies exist.
echo "Starting Gunicorn..."
gunicorn -w 4 -k uvicorn.workers.UvicornWorker main:app
