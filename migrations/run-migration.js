#!/usr/bin/env node

/**
 * Run database migration to add meta flag
 * This script adds the meta column and marks polluted memories
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import chalk from 'chalk';

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

async function runMigration() {
    try {
        console.log(chalk.cyan('🔧 Running meta flag migration...\\n'));

        // Read SQL file
        const sqlPath = path.join(projectRoot, 'migrations', 'add-meta-flag.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        // Split into individual statements
        const statements = sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

        for (const statement of statements) {
            if (statement.startsWith('SELECT')) {
                // Query statement - show results
                const { data, error } = await supabase.rpc('exec_sql', { sql_query: statement });
                if (error) throw error;
                console.log(chalk.green('✅ Migration summary:'));
                console.table(data);
            } else {
                // DDL/DML statement - execute
                const { error } = await supabase.rpc('exec_sql', { sql_query: statement });
                if (error) throw error;
                console.log(chalk.gray(`✓ Executed: ${statement.substring(0, 50)}...`));
            }
        }

        console.log(chalk.green('\\n✅ Migration complete!'));
        console.log(chalk.gray('Meta-flagged messages will be excluded from retrieval.'));

    } catch (error) {
        console.error(chalk.red('❌ Migration failed:'), error.message);
        process.exit(1);
    }
}

runMigration();
