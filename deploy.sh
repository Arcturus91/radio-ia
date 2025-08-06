#!/bin/bash
# deploy.sh - RadioIA Deployment Script

set -e  # Exit on any error

echo "🚀 Deploying RadioIA Content Processor..."

# Install dependencies for all Lambda functions
echo "📦 Installing dependencies..."
for func_dir in src/functions/*/; do
  if [ -f "$func_dir/package.json" ]; then
    echo "Installing dependencies for $(basename $func_dir)"
    cd "$func_dir"
    npm ci --only=production --silent
    cd - > /dev/null
  fi
done

# Build SAM application
echo "🔨 Building SAM application..."
sam build

# Deploy to AWS
echo "🚀 Deploying to AWS..."
sam deploy --no-fail-on-empty-changeset --force-upload

echo ""
echo "✅ Deployment completed successfully!"
echo "Stack: radioia-processor"
echo "Region: sa-east-1"
echo ""
echo "📊 Stack Outputs:"
aws cloudformation describe-stacks --stack-name radioia-processor --region sa-east-1 --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table
