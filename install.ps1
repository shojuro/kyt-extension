#!/usr/bin/env pwsh
<#
.SYNOPSIS
    KYT CLI Memory Tool - Windows Installation Script

.DESCRIPTION
    Automates installation of the 'mem' command globally on Windows.
    Creates platform-specific wrappers (mem.cmd and mem.ps1) automatically.

.NOTES
    Author: KYT Memory Extension Team
    Date: 2025-11-15
    Requires: Node.js v20+ and npm

.EXAMPLE
    .\install.ps1
    Installs the mem command globally for Windows
#>

# Enable strict mode
$ErrorActionPreference = "Stop"

Write-Host "🚀 KYT CLI Memory Tool - Windows Installation" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Gray
Write-Host ""

# Check Node.js installation
Write-Host "Checking Node.js installation..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "✅ Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ ERROR: Node.js not found" -ForegroundColor Red
    Write-Host "Please install Node.js v20+ from https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

# Check npm installation
Write-Host "Checking npm installation..." -ForegroundColor Yellow
try {
    $npmVersion = npm --version
    Write-Host "✅ npm $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ ERROR: npm not found" -ForegroundColor Red
    Write-Host "npm should come with Node.js. Please reinstall Node.js." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ ERROR: npm install failed" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Dependencies installed" -ForegroundColor Green

Write-Host ""
Write-Host "Creating global link..." -ForegroundColor Yellow
npm link
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ ERROR: npm link failed" -ForegroundColor Red
    Write-Host "Try running PowerShell as Administrator" -ForegroundColor Yellow
    exit 1
}
Write-Host "✅ Global link created" -ForegroundColor Green

# Verify installation
Write-Host ""
Write-Host "Verifying installation..." -ForegroundColor Yellow

$npmPrefix = npm config get prefix
$expectedCmdPath = Join-Path $npmPrefix "mem.cmd"
$expectedPs1Path = Join-Path $npmPrefix "mem.ps1"

if (Test-Path $expectedCmdPath) {
    Write-Host "✅ mem.cmd created: $expectedCmdPath" -ForegroundColor Green
} else {
    Write-Host "⚠️  WARNING: mem.cmd not found at $expectedCmdPath" -ForegroundColor Yellow
}

if (Test-Path $expectedPs1Path) {
    Write-Host "✅ mem.ps1 created: $expectedPs1Path" -ForegroundColor Green
} else {
    Write-Host "⚠️  WARNING: mem.ps1 not found (older npm version)" -ForegroundColor Yellow
    Write-Host "   This is OK - mem.cmd will work in PowerShell" -ForegroundColor Gray
}

# Check if command is accessible
Write-Host ""
Write-Host "Testing 'mem' command..." -ForegroundColor Yellow
try {
    $memCommand = Get-Command mem -ErrorAction Stop
    Write-Host "✅ 'mem' command is accessible" -ForegroundColor Green
    Write-Host "   Location: $($memCommand.Source)" -ForegroundColor Gray
} catch {
    Write-Host "⚠️  WARNING: 'mem' command not found in PATH" -ForegroundColor Yellow
    Write-Host "   You may need to restart PowerShell or add npm to PATH" -ForegroundColor Gray
    Write-Host "   npm bin directory: $npmPrefix" -ForegroundColor Gray
}

# Environment variables check
Write-Host ""
Write-Host "Checking environment variables..." -ForegroundColor Yellow

$envVars = @('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'OPENAI_API_KEY')
$missingVars = @()

foreach ($var in $envVars) {
    if ([System.Environment]::GetEnvironmentVariable($var)) {
        Write-Host "✅ $var is set" -ForegroundColor Green
    } else {
        Write-Host "⚠️  $var not set" -ForegroundColor Yellow
        $missingVars += $var
    }
}

if ($missingVars.Count -gt 0) {
    Write-Host ""
    Write-Host "⚠️  Missing environment variables detected" -ForegroundColor Yellow
    Write-Host "You have two options:" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Option 1: Use .env file (recommended for testing)" -ForegroundColor Cyan
    Write-Host "   - Keep .env file in project directory" -ForegroundColor Gray
    Write-Host "   - Run 'mem' from project directory" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Option 2: Set environment variables globally" -ForegroundColor Cyan
    Write-Host "   Run these commands (replace with your actual values):" -ForegroundColor Gray
    Write-Host ""
    foreach ($var in $missingVars) {
        Write-Host "   [System.Environment]::SetEnvironmentVariable('$var', 'your-value-here', 'User')" -ForegroundColor White
    }
    Write-Host ""
    Write-Host "   Then restart PowerShell for changes to take effect." -ForegroundColor Gray
}

# Final instructions
Write-Host ""
Write-Host "=" * 60 -ForegroundColor Gray
Write-Host "✅ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Test the installation:" -ForegroundColor Cyan
Write-Host "   mem `"Hello from Windows!`"" -ForegroundColor White
Write-Host ""
Write-Host "Usage examples:" -ForegroundColor Cyan
Write-Host "   mem `"Remember: Fixed the RLS policy error`"" -ForegroundColor White
Write-Host "   npm test | mem --pipe `"Test results`"" -ForegroundColor White
Write-Host "   Get-Content error.log | mem --pipe `"Error log`"" -ForegroundColor White
Write-Host ""
Write-Host "Documentation:" -ForegroundColor Cyan
Write-Host "   See CLI_USAGE.md for full documentation" -ForegroundColor White
Write-Host "   Windows-specific section available" -ForegroundColor Gray
Write-Host ""
Write-Host "=" * 60 -ForegroundColor Gray
