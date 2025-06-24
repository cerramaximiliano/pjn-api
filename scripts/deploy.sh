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
npm ci --production

echo "🔄 Reloading PM2..."
if command -v pm2 &> /dev/null; then
  # PM2 is in user path
  pm2 reload ecosystem.config.js --env production
  pm2 save
  echo "📊 PM2 Status:"
  pm2 status
elif sudo -n command -v pm2 &> /dev/null 2>&1; then
  # PM2 needs sudo
  sudo pm2 reload ecosystem.config.js --env production
  sudo pm2 save
  echo "📊 PM2 Status:"
  sudo pm2 status
else
  echo "❌ Error: PM2 not found"
  exit 1
fi

echo "✅ Deployment completed successfully!"