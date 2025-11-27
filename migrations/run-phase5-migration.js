#!/usr/bin/env node

/**
 * Run Phase 5 Migration: Multi-User Support
 * Adds: user_id column to messages
 * Deploys: RLS policies for security
 * Author: K.Y.T. Team
 * Date: 2025-11-27
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Mock chalk to avoid dependency issues
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
    try {
        // Try using the SQL query directly via a helper RPC if it exists
        // Note: This requires a 'query' or 'exec_sql' function to be defined in the DB
        // If not, we print manual instructions.
        const { data, error } = await supabase.rpc('query', { query_text: sql });

        if (error) {
            console.log(chalk.yellow('⚠️  RPC execution failed (function "query" might not exist).'));
            console.log(chalk.yellow(`    Please run ${filename} manually in Supabase SQL Editor.`));
            console.error(chalk.red(`    Error: ${error.message}`));
        } else {
            console.log(chalk.green(`  ✅ ${description} complete (via RPC)`));
        }
    } catch (err) {
        console.error(chalk.red(`  ❌ Error: ${err.message}`));
        throw err;
    }
}

async function verifyMigration() {
    console.log(chalk.cyan('\n🔍 Verifying migration...'));

    try {
        // Check if user_id column exists in messages
        const { data, error } = await supabase
            .from('messages')
            .select('user_id')
            .limit(1);

        if (error) {
            console.error(chalk.red(`❌ Verification failed: ${error.message}`));
            return false;
        }

        console.log(chalk.green('✅ user_id column exists in messages table'));
        return true;
    } catch (err) {
        console.error(chalk.red(`❌ Verification error: ${err.message}`));
        return false;
    }
}

async function runMigration() {
    try {
        console.log(chalk.bold.cyan('\n╔════════════════════════════════════════════════════╗'));
        console.log(chalk.bold.cyan('║  PHASE 5 MIGRATION (Multi-User Support)           ║'));
        console.log(chalk.bold.cyan('╚════════════════════════════════════════════════════╝\n'));

        // Step 1: Add user_id column
        await executeSQLFile(
            'migration_add_userid.sql',
            'Adding user_id column and updating search function'
        );

        // Step 2: Add RLS policies
        await executeSQLFile(
            'migrations/add_rls_policies.sql',
            'Enabling RLS and adding security policies'
        );

        // Verification
        const success = await verifyMigration();

        if (success) {
            console.log(chalk.bold.green('\n✅ MIGRATION VERIFIED!'));
            console.log(chalk.gray('\nNext steps:'));
            console.log(chalk.gray('  1. Update CLI to use user authentication'));
            console.log(chalk.gray('  2. Test multi-user isolation'));
        } else {
            console.log(chalk.bold.yellow('\n⚠️  MIGRATION VERIFICATION FAILED'));
            console.log(chalk.yellow('Please check the errors above and run SQL manually if needed.'));
        }

    } catch (error) {
        console.error(chalk.bold.red('\n❌ MIGRATION FAILED'));
        console.error(chalk.red(error.message));
        process.exit(1);
    }
}

runMigration();
