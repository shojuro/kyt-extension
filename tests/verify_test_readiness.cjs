#!/usr/bin/env node
/**
 * Mobile Voice Capture Test Readiness Checker
 *
 * Verifies that all prerequisites are met for running automated tests.
 * Run this before executing the test suite to catch issues early.
 *
 * Usage:
 *   node tests/verify_test_readiness.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset', prefix = '') {
  console.log(`${prefix}${colors[color]}${message}${colors.reset}`);
}

function checkFile(filePath, description) {
  if (fs.existsSync(filePath)) {
    log(`✓ ${description}`, 'green', '  ');
    return true;
  } else {
    log(`✗ ${description}`, 'red', '  ');
    return false;
  }
}

function checkNodeModule(moduleName) {
  try {
    require.resolve(moduleName);
    log(`✓ ${moduleName} installed`, 'green', '  ');
    return true;
  } catch (e) {
    log(`✗ ${moduleName} not found`, 'red', '  ');
    return false;
  }
}

function checkSyntax(filePath, description) {
  try {
    execSync(`node -c "${filePath}"`, { stdio: 'pipe' });
    log(`✓ ${description}`, 'green', '  ');
    return true;
  } catch (e) {
    log(`✗ ${description} - Syntax error`, 'red', '  ');
    console.error('   ', e.stderr?.toString().trim());
    return false;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('Mobile Voice Capture - Test Readiness Check', 'bright');
  console.log('='.repeat(60) + '\n');

  let allPassed = true;

  // 1. Check required extension files
  log('📂 Checking Extension Files...', 'cyan');
  const extensionFiles = [
    ['manifest.json', 'Extension manifest'],
    ['background.js', 'Background script'],
    ['platforms/chatgpt/content.js', 'Content script'],
    ['platforms/chatgpt/dom-observer.js', 'DOM observer']
  ];

  for (const [file, desc] of extensionFiles) {
    const fullPath = path.join(__dirname, '..', file);
    if (!checkFile(fullPath, desc)) {
      allPassed = false;
    }
  }

  // 2. Check test files
  log('\n📝 Checking Test Files...', 'cyan');
  const testFiles = [
    ['scripts/test_mobile_voice_capture.js', 'Test script'],
    ['tests/run_mobile_voice_tests.cjs', 'Test runner']
  ];

  for (const [file, desc] of testFiles) {
    const fullPath = path.join(__dirname, '..', file);
    if (!checkFile(fullPath, desc)) {
      allPassed = false;
    }
  }

  // 3. Check Node.js dependencies
  log('\n📦 Checking Dependencies...', 'cyan');
  const dependencies = ['playwright'];

  for (const dep of dependencies) {
    if (!checkNodeModule(dep)) {
      allPassed = false;
      log(`   Run: npm install ${dep}`, 'yellow', '   ');
    }
  }

  // 4. Check syntax of implementation files
  log('\n✅ Validating Syntax...', 'cyan');
  const syntaxFiles = [
    ['platforms/chatgpt/dom-observer.js', 'DOM observer syntax'],
    ['scripts/test_mobile_voice_capture.js', 'Test script syntax'],
    ['tests/run_mobile_voice_tests.cjs', 'Test runner syntax']
  ];

  for (const [file, desc] of syntaxFiles) {
    const fullPath = path.join(__dirname, '..', file);
    if (fs.existsSync(fullPath)) {
      if (!checkSyntax(fullPath, desc)) {
        allPassed = false;
      }
    }
  }

  // 5. Check package.json script
  log('\n🔧 Checking Package Scripts...', 'cyan');
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.scripts && packageJson.scripts['test:mobile-voice']) {
      log('✓ npm run test:mobile-voice script configured', 'green', '  ');
    } else {
      log('✗ test:mobile-voice script not found in package.json', 'red', '  ');
      allPassed = false;
    }
  }

  // 6. Check for validation theater patterns
  log('\n🔍 Checking for Validation Theater...', 'cyan');
  const testScriptPath = path.join(__dirname, '..', 'scripts/test_mobile_voice_capture.js');
  if (fs.existsSync(testScriptPath)) {
    const testContent = fs.readFileSync(testScriptPath, 'utf8');
    const theaterPatterns = testContent.match(/\|\|\s*true/g);

    if (theaterPatterns && theaterPatterns.length > 0) {
      log(`⚠ Found ${theaterPatterns.length} validation theater pattern(s)`, 'yellow', '  ');
      log('  These assertions will always pass (|| true)', 'yellow', '  ');
      log('  Consider fixing or marking as SKIP', 'yellow', '  ');
    } else {
      log('✓ No validation theater detected', 'green', '  ');
    }
  }

  // 7. Check .gitignore
  log('\n🔒 Checking .gitignore...', 'cyan');
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');

    const requiredPatterns = [
      ['.test-profile/', 'Test browser profile'],
      ['test-results/', 'Test results directory']
    ];

    for (const [pattern, desc] of requiredPatterns) {
      if (gitignoreContent.includes(pattern)) {
        log(`✓ ${desc} ignored`, 'green', '  ');
      } else {
        log(`⚠ ${desc} not in .gitignore`, 'yellow', '  ');
        log(`  Add: ${pattern}`, 'yellow', '  ');
      }
    }
  }

  // 8. Environment checks
  log('\n🌍 Checking Environment...', 'cyan');
  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    log(`✓ Node.js ${nodeVersion}`, 'green', '  ');
  } catch (e) {
    log('✗ Node.js not found', 'red', '  ');
    allPassed = false;
  }

  try {
    const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
    log(`✓ npm ${npmVersion}`, 'green', '  ');
  } catch (e) {
    log('✗ npm not found', 'red', '  ');
    allPassed = false;
  }

  // Final verdict
  console.log('\n' + '='.repeat(60));
  if (allPassed) {
    log('✅ ALL CHECKS PASSED - Ready to run tests!', 'green');
    log('\nRun: npm run test:mobile-voice', 'cyan');
  } else {
    log('❌ SOME CHECKS FAILED - Fix issues before running tests', 'red');
    log('\nReview the errors above and resolve them.', 'yellow');
  }
  console.log('='.repeat(60) + '\n');

  process.exit(allPassed ? 0 : 1);
}

main().catch(error => {
  console.error('\n💥 Verification error:', error.message);
  process.exit(1);
});
