#!/bin/bash
# Entity Memory Deployment Script
# Purpose: Deploy entity memory feature to Supabase production
# Date: 2025-11-25

set -e  # Exit on error

echo "=========================================="
echo "Entity Memory Deployment"
echo "=========================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."

# 1. Check Supabase CLI
if ! command -v supabase &> /dev/null; then
    echo "❌ ERROR: Supabase CLI not found"
    echo "Install: npm install -g supabase"
    exit 1
fi
echo "✅ Supabase CLI found"

# 2. Check project link
if [ ! -f "supabase/.temp/project-ref" ]; then
    echo "❌ ERROR: Supabase project not linked"
    echo "Run: supabase link --project-ref YOUR_PROJECT_REF"
    exit 1
fi
echo "✅ Supabase project linked"

# 3. Check environment variables
if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  WARNING: OPENAI_API_KEY not set in environment"
    echo "Make sure it's configured in Supabase dashboard: Settings > Edge Functions > Secrets"
fi

echo ""
echo "=========================================="
echo "Step 1: Apply Database Migration"
echo "=========================================="
echo ""

# Apply entity_memory.sql migration
echo "Applying migrations/entity_memory.sql..."
supabase db push

echo "✅ Migration applied"

echo ""
echo "=========================================="
echo "Step 2: Deploy Edge Function"
echo "=========================================="
echo ""

# Deploy save_chat_turn with entity extraction
echo "Deploying save_chat_turn Edge Function..."
supabase functions deploy save_chat_turn

echo "✅ Edge Function deployed"

echo ""
echo "=========================================="
echo "Step 3: Verify Deployment"
echo "=========================================="
echo ""

# Run verification script
echo "Running verification tests..."
node scripts/verify_entity_memory.js

echo ""
echo "=========================================="
echo "Deployment Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Check Supabase logs: supabase functions logs save_chat_turn"
echo "2. Test with real conversation data"
echo "3. Verify entities table populated"
echo ""
