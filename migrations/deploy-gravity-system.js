#!/usr/bin/env node

/**
 * Deploy Temporal Decay (Gravity Scoring) System
 * Executes SQL migrations using direct PostgreSQL connection
 *
 * Steps:
 * 1. Add gravity columns to chat_turns table
 * 2. Deploy calculate_gravity_score() function
 * 3. Deploy match_messages_with_gravity() functions
 * 4. Deploy access tracking functions
 * 5. Verify all changes
 *
 * Author: Temporal Decay Feature Implementation
 * Date: 2025-11-24
 */

import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import chalk from 'chalk';

// Load env vars
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../');
dotenv.config({ path: path.join(projectRoot, '.env') });

// Get Supabase connection string (constructed from URL + service key)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl) {
    console.error(chalk.red('❌ Missing SUPABASE_URL in .env'));
    process.exit(1);
}

// Extract project ref from Supabase URL
// Format: https://xxxxx.supabase.co
const projectRef = supabaseUrl.match(/https:\/\/([^\.]+)\.supabase\.co/)?.[1];

if (!projectRef) {
    console.error(chalk.red('❌ Could not parse project ref from SUPABASE_URL'));
    console.error(chalk.yellow('Expected format: https://xxxxx.supabase.co'));
    process.exit(1);
}

// Construct Postgres connection string
// Format: postgresql://postgres.[ref]:[password]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
// Note: This may need adjustment based on your Supabase connection pooler settings

console.log(chalk.yellow('⚠️  DATABASE CONNECTION REQUIRED'));
console.log(chalk.gray('This script needs a direct PostgreSQL connection.'));
console.log(chalk.gray('Get connection string from: Supabase Dashboard → Settings → Database\n'));

// Check for DATABASE_URL or construct warning
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    console.log(chalk.bold.yellow('╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.yellow('║  MANUAL MIGRATION REQUIRED                                 ║'));
    console.log(chalk.bold.yellow('╚════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.cyan('DATABASE_URL not found in .env'));
    console.log(chalk.gray('\nTo run migrations automatically, add to .env:'));
    console.log(chalk.green('DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.' + projectRef + '.supabase.co:5432/postgres\n'));

    console.log(chalk.cyan('OR run migrations manually in Supabase SQL Editor:'));
    console.log(chalk.gray('1. Open: https://supabase.com/dashboard/project/' + projectRef + '/sql/new'));
    console.log(chalk.gray('2. Paste and run each file in order:'));
    console.log(chalk.yellow('   → migrations/add_gravity_columns.sql'));
    console.log(chalk.yellow('   → supabase/functions/_sql/calculate_gravity_score.sql'));
    console.log(chalk.yellow('   → supabase/functions/_sql/search_with_gravity.sql'));
    console.log(chalk.yellow('   → migrations/add_access_tracking_trigger.sql\n'));

    console.log(chalk.gray('After running, verify with:'));
    console.log(chalk.green('SELECT column_name FROM information_schema.columns WHERE table_name = \'chat_turns\' AND column_name LIKE \'%gravity%\';\n'));

    process.exit(0);
}

async function executeSQLFile(client, filename, description) {
    console.log(chalk.cyan(`\n🔧 ${description}...`));

    const sqlPath = path.join(projectRoot, filename);
    if (!fs.existsSync(sqlPath)) {
        throw new Error(`SQL file not found: ${sqlPath}`);
    }

    const sql = fs.readFileSync(sqlPath, 'utf8');

    try {
        await client.query(sql);
        console.log(chalk.green(`✅ ${description} complete`));
    } catch (err) {
        console.error(chalk.red(`❌ Error in ${description}:`));
        console.error(chalk.red(err.message));
        throw err;
    }
}

async function verifyMigration(client) {
    console.log(chalk.cyan('\n🔍 Verifying migration...'));

    try {
        // Check columns exist
        const colQuery = `
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'chat_turns'
            AND column_name IN ('impact_score', 'intimacy_level', 'gravity_score', 'access_count', 'last_accessed')
            ORDER BY column_name;
        `;

        const colResult = await client.query(colQuery);

        if (colResult.rows.length < 5) {
            console.error(chalk.red(`❌ Expected 5 columns, found ${colResult.rows.length}`));
            console.table(colResult.rows);
            return false;
        }

        console.log(chalk.green('✅ All gravity columns exist:'));
        console.table(colResult.rows);

        // Check functions exist
        const funcQuery = `
            SELECT routine_name
            FROM information_schema.routines
            WHERE routine_schema = 'public'
            AND routine_name LIKE '%gravity%'
            ORDER BY routine_name;
        `;

        const funcResult = await client.query(funcQuery);

        if (funcResult.rows.length === 0) {
            console.warn(chalk.yellow('⚠️  No gravity functions found (may need manual deployment)'));
        } else {
            console.log(chalk.green('\n✅ Gravity functions deployed:'));
            console.table(funcResult.rows);
        }

        return true;
    } catch (err) {
        console.error(chalk.red(`❌ Verification error: ${err.message}`));
        return false;
    }
}

async function runMigration() {
    const client = new Client({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false }  // Supabase requires SSL
    });

    try {
        console.log(chalk.bold.cyan('\n╔════════════════════════════════════════════════════╗'));
        console.log(chalk.bold.cyan('║  TEMPORAL DECAY MIGRATION (Gravity Scoring)       ║'));
        console.log(chalk.bold.cyan('╚════════════════════════════════════════════════════╝\n'));

        console.log(chalk.gray('Connecting to database...'));
        await client.connect();
        console.log(chalk.green('✅ Connected\n'));

        // Step 1: Add columns
        await executeSQLFile(
            client,
            'migrations/add_gravity_columns.sql',
            'Adding gravity score columns'
        );

        // Step 2: Deploy gravity calculation function
        await executeSQLFile(
            client,
            'supabase/functions/_sql/calculate_gravity_score.sql',
            'Deploying calculate_gravity_score() function'
        );

        // Step 3: Deploy search functions
        await executeSQLFile(
            client,
            'supabase/functions/_sql/search_with_gravity.sql',
            'Deploying match_messages_with_gravity() functions'
        );

        // Step 4: Deploy access tracking
        await executeSQLFile(
            client,
            'migrations/add_access_tracking_trigger.sql',
            'Deploying access tracking functions'
        );

        // Verification
        const success = await verifyMigration(client);

        if (success) {
            console.log(chalk.bold.green('\n✅ MIGRATION COMPLETE!'));
            console.log(chalk.gray('\nGravity scoring system deployed successfully.'));
            console.log(chalk.gray('\nNext steps:'));
            console.log(chalk.gray('  1. Configure Edge Functions (see supabase/.env.example)'));
            console.log(chalk.gray('  2. Deploy save_chat_turn function'));
            console.log(chalk.gray('  3. Test end-to-end integration'));
        } else {
            console.log(chalk.bold.yellow('\n⚠️  MIGRATION PARTIALLY COMPLETE'));
            console.log(chalk.yellow('Some components may need manual review'));
        }

    } catch (error) {
        console.error(chalk.bold.red('\n❌ MIGRATION FAILED'));
        console.error(chalk.red(error.message));
        if (error.stack) {
            console.error(chalk.gray(error.stack));
        }
        process.exit(1);
    } finally {
        await client.end();
    }
}

runMigration();
