#!/bin/bash

# Deploy script for EC2
# This script can be used for manual deployments or as part of the CI/CD pipeline

set -e

echo "🚀 Starting deployment..."

# Variables
APP_DIR="$HOME/pjn-api"
PM2_APP_NAME="pjn/api"

# Navigate to app directory
cd "$APP_DIR"

echo "📦 Installing dependencies..."
sudo su - root -c "cd $PWD && npm ci --production"

echo "🔄 Reloading PM2..."
sudo su - root -c "cd $PWD && pm2 reload ecosystem.config.js --env production"
sudo su - root -c "pm2 save"

echo "📊 PM2 Status:"
sudo su - root -c "pm2 status"

echo "✅ Deployment completed successfully!"