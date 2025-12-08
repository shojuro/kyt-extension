#!/bin/bash

# K.Y.T. Defiance Test Suite - Quick Test Script
# This script sets up test memories for the defiance test suite

set -e

echo "🧪 K.Y.T. Defiance Test Suite - Memory Setup"
echo "=============================================="
echo ""

# Check if mem command exists
if ! command -v mem &> /dev/null; then
    echo "❌ Error: 'mem' command not found"
    echo "   Please ensure cli/mem.js is in your PATH or run from cli directory"
    echo "   Run: cd cli && npm link"
    exit 1
fi

echo "📝 Setting up test memories..."
echo ""

# Test 1: Literal Match (Password)
echo "Test 1: Literal Match"
mem save "The password is hunter2"
echo "✅ Saved: Password test memory"
echo ""

# Test 2: Marker Recognition
echo "Test 2: Marker Recognition"
mem save "@@@TestMarker123"
echo "✅ Saved: Marker test memory"
echo ""

# Test 3: Counter Test (Original Bug)
echo "Test 3: Counter Test"
mem save "This is a test memory that I have brought to the masses as a counter."
echo "✅ Saved: Counter test memory"
echo ""

# Test 4: High Confidence
echo "Test 4: High Confidence"
mem save "The secret ingredient is xylophone dust on Tuesdays"
echo "✅ Saved: Secret ingredient test memory"
echo ""

# Test 6: Conflict Resolution (Part 1)
echo "Test 6: Conflict Resolution (Part 1)"
mem save "My favorite color is blue"
echo "✅ Saved: First favorite color"
echo "   Waiting 5 seconds..."
sleep 5

# Test 6: Conflict Resolution (Part 2)
echo "Test 6: Conflict Resolution (Part 2)"
mem save "My favorite color is red"
echo "✅ Saved: Second favorite color"
echo ""

echo "=============================================="
echo "✅ All test memories saved successfully!"
echo ""
echo "📋 Next Steps:"
echo "1. Open ChatGPT (https://chatgpt.com)"
echo "2. Enable debug mode in extension popup"
echo "3. Run the test queries from DEFIANCE_TEST_SUITE.md"
echo ""
echo "Test Queries:"
echo "  1. What's the password?"
echo "  2. What's the test marker?"
echo "  3. What did I bring to the masses as a counter?"
echo "  4. What's the secret ingredient on Tuesdays?"
echo "  5. What is the capital of Bhutan? (should allow native search)"
echo "  6. What's my favorite color?"
echo ""
echo "See docs/DEFIANCE_TEST_SUITE.md for detailed verification steps"
