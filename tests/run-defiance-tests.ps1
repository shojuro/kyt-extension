# K.Y.T. Defiance Test Suite - Quick Setup (PowerShell)

Write-Host "🧪 K.Y.T. Defiance Test Suite - Memory Setup" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Check if mem command exists
$memCommand = Get-Command mem -ErrorAction SilentlyContinue
if (-not $memCommand) {
    Write-Host "❌ Error: 'mem' command not found" -ForegroundColor Red
    Write-Host "   Please ensure cli/mem.js is configured" -ForegroundColor Yellow
    Write-Host "   Run from WSL: cd cli && npm link" -ForegroundColor Yellow
    exit 1
}

Write-Host "📝 Setting up test memories..." -ForegroundColor Green
Write-Host ""

# Navigate to CLI directory
Set-Location -Path "cli"

# Test 1: Literal Match (Password)
Write-Host "Test 1: Literal Match" -ForegroundColor White
node mem.js save "The password is hunter2"
Write-Host "✅ Saved: Password test memory" -ForegroundColor Green
Write-Host ""

# Test 2: Marker Recognition  
Write-Host "Test 2: Marker Recognition" -ForegroundColor White
node mem.js save "@@@TestMarker123"
Write-Host "✅ Saved: Marker test memory" -ForegroundColor Green
Write-Host ""

# Test 3: Counter Test (Original Bug)
Write-Host "Test 3: Counter Test" -ForegroundColor White
node mem.js save "This is a test memory that I have brought to the masses as a counter."
Write-Host "✅ Saved: Counter test memory" -ForegroundColor Green
Write-Host ""

# Test 4: High Confidence
Write-Host "Test 4: High Confidence" -ForegroundColor White
node mem.js save "The secret ingredient is xylophone dust on Tuesdays"
Write-Host "✅ Saved: Secret ingredient test memory" -ForegroundColor Green
Write-Host ""

# Test 6: Conflict Resolution (Part 1)
Write-Host "Test 6: Conflict Resolution (Part 1)" -ForegroundColor White
node mem.js save "My favorite color is blue"
Write-Host "✅ Saved: First favorite color" -ForegroundColor Green
Write-Host "   Waiting 5 seconds..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Test 6: Conflict Resolution (Part 2)
Write-Host "Test 6: Conflict Resolution (Part 2)" -ForegroundColor White
node mem.js save "My favorite color is red"
Write-Host "✅ Saved: Second favorite color" -ForegroundColor Green
Write-Host ""

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "✅ All test memories saved successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next Steps:" -ForegroundColor Cyan
Write-Host "1. Open ChatGPT (https://chatgpt.com)" -ForegroundColor White
Write-Host "2. Enable debug mode in extension popup" -ForegroundColor White
Write-Host "3. Run the test queries from DEFIANCE_TEST_SUITE.md" -ForegroundColor White
Write-Host ""
Write-Host "Test Queries:" -ForegroundColor Yellow
Write-Host "  1. What's the password?" -ForegroundColor White
Write-Host "  2. What's the test marker?" -ForegroundColor White
Write-Host "  3. What did I bring to the masses as a counter?" -ForegroundColor White
Write-Host "  4. What's the secret ingredient on Tuesdays?" -ForegroundColor White
Write-Host "  5. What is the capital of Bhutan? (should allow native search)" -ForegroundColor White
Write-Host "  6. What's my favorite color?" -ForegroundColor White
Write-Host ""
Write-Host "See docs/DEFIANCE_TEST_SUITE.md for detailed verification steps" -ForegroundColor Cyan

# Return to root directory
Set-Location -Path ".."
