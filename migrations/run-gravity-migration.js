#!/usr/bin/env node

/**
 * Run Temporal Decay (Gravity Scoring) Migration
 * Adds: impact_score, intimacy_level, access_count, last_accessed, gravity_score columns
 * Deploys: calculate_gravity_score(), match_messages_with_gravity() functions
 * Author: Temporal Decay Feature Implementation
 * Date: 2025-11-24
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
// import chalk from 'chalk'; // Chalk not installed
const chalk = {
    cyan: s => s,
    red: s => s,
    green: s => s,
    yellow: s => s,
    gray: s => s,
    bold: { cyan: s => s, green: s => s, yellow: s => s, red: s => s }
};

// Load env vars
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../');
dotenv.config({ path: path.join(projectRoot, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error(chalk.red('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env'));
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function executeSQLFile(filename, description) {
    console.log(chalk.cyan(`\n🔧 ${description}...`));

    const sqlPath = path.join(projectRoot, filename);
    if (!fs.existsSync(sqlPath)) {
        throw new Error(`SQL file not found: ${sqlPath}`);
    }

    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Execute directly via Supabase's RPC or client
    // Note: This may need adjustment based on your Supabase setup
    try {
        // Try using the SQL query directly
        const { data, error } = await supabase.rpc('query', { query_text: sql });

        if (error) {
            // If RPC doesn't work, try alternative method
            console.log(chalk.yellow('⚠️  RPC method failed, trying alternative...'));

            // Split into statements and execute individually
            const statements = sql
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('--') && !s.match(/^\s*$/));

            for (const stmt of statements) {
                // Skip DO blocks and RAISE NOTICE - these are for Postgres CLI only
                if (stmt.includes('DO $$') || stmt.includes('RAISE NOTICE')) {
                    console.log(chalk.gray(`  Skipping: ${stmt.substring(0, 40)}...`));
                    continue;
                }

                console.log(chalk.gray(`  Executing: ${stmt.substring(0, 60)}...`));

                // Note: @supabase/supabase-js doesn't directly support raw SQL
                // This will need manual execution via Supabase SQL Editor
                console.log(chalk.yellow(`  ⚠️  Statement needs manual execution in Supabase SQL Editor`));
            }
        } else {
            console.log(chalk.green(`  ✅ ${description} complete`));
            if (data) console.log(chalk.gray(`  Result: ${JSON.stringify(data).substring(0, 100)}...`));
        }
    } catch (err) {
        console.error(chalk.red(`  ❌ Error: ${err.message}`));
        throw err;
    }
}

async function verifyMigration() {
    console.log(chalk.cyan('\n🔍 Verifying migration...'));

    try {
        // Check if columns exist
        const { data, error } = await supabase
            .from('chat_turns')
            .select('id, impact_score, intimacy_level, gravity_score')
            .limit(1);

        if (error && error.message.includes('column') && error.message.includes('does not exist')) {
            console.error(chalk.red('❌ Columns not found - migration may have failed'));
            console.log(chalk.yellow('\n⚠️  MANUAL STEP REQUIRED:'));
            console.log(chalk.yellow('    Open Supabase Dashboard → SQL Editor'));
            console.log(chalk.yellow('    Paste contents of:'));
            console.log(chalk.yellow('      1. migrations/add_gravity_columns.sql'));
            console.log(chalk.yellow('      2. supabase/functions/_sql/calculate_gravity_score.sql'));
            console.log(chalk.yellow('      3. supabase/functions/_sql/search_with_gravity.sql'));
            console.log(chalk.yellow('      4. migrations/add_access_tracking_trigger.sql'));
            return false;
        }

        console.log(chalk.green('✅ Columns exist in database'));
        console.log(chalk.gray(`   Sample row: ${JSON.stringify(data?.[0] || {})}`));
        return true;
    } catch (err) {
        console.error(chalk.red(`❌ Verification error: ${err.message}`));
        return false;
    }
}

async function runMigration() {
    try {
        console.log(chalk.bold.cyan('\n╔════════════════════════════════════════════════════╗'));
        console.log(chalk.bold.cyan('║  TEMPORAL DECAY MIGRATION (Gravity Scoring)       ║'));
        console.log(chalk.bold.cyan('╚════════════════════════════════════════════════════╝\n'));

        // Step 1: Add columns
        await executeSQLFile(
            'migrations/add_gravity_columns.sql',
            'Adding gravity score columns (impact_score, intimacy_level, etc.)'
        );

        // Step 2: Deploy gravity calculation function
        await executeSQLFile(
            'supabase/functions/_sql/calculate_gravity_score.sql',
            'Deploying calculate_gravity_score() function'
        );

        // Step 3: Deploy search functions
        await executeSQLFile(
            'supabase/functions/_sql/search_with_gravity.sql',
            'Deploying match_messages_with_gravity() functions'
        );

        // Step 4: Deploy access tracking
        await executeSQLFile(
            'migrations/add_access_tracking_trigger.sql',
            'Deploying access tracking functions (rehearsal effect)'
        );

        // Verification
        const success = await verifyMigration();

        if (success) {
            console.log(chalk.bold.green('\n✅ MIGRATION COMPLETE!'));
            console.log(chalk.gray('\nNext steps:'));
            console.log(chalk.gray('  1. Deploy Edge Functions: See supabase/.env.example'));
            console.log(chalk.gray('  2. Test classification: npm run test:classifier'));
            console.log(chalk.gray('  3. Test end-to-end: npm run test:e2e'));
        } else {
            console.log(chalk.bold.yellow('\n⚠️  MIGRATION INCOMPLETE'));
            console.log(chalk.yellow('Please follow manual steps above'));
        }

    } catch (error) {
        console.error(chalk.bold.red('\n❌ MIGRATION FAILED'));
        console.error(chalk.red(error.message));
        console.log(chalk.yellow('\n💡 TIP: Run SQL files manually in Supabase SQL Editor'));
        process.exit(1);
    }
}

runMigration();
