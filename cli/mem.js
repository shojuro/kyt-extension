#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import login from './src/commands/login.js';
import save from './src/commands/save.js';
import watch from './src/commands/watch.js';
import sync from './src/commands/sync.js';
import markMeta from './src/commands/mark-meta.js';
import purgeMeta from './src/commands/purge-meta.js';

// Load env vars from parent directory (project root)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../');
dotenv.config({ path: path.join(projectRoot, '.env') });

const program = new Command();

program
  .name('mem')
  .description('AI Memory CLI - The Developer Arm of your Second Brain')
  .version('1.0.0');

program
  .command('login')
  .description('Authenticate with Supabase')
  .action(login);

program
  .command('save [text]')
  .description('Explicitly save a memory (or pipe input)')
  .action(save);

program
  .command('watch')
  .description('Watch Claude Code logs for new memories')
  .option('-d, --daemon', 'Run in background')
  .action(watch);

program
  .command('sync')
  .description('Sync relevant memories to CLAUDE.md')
  .action(sync);

program
  .command('mark-meta')
  .description('Mark messages as meta-conversations (excluded from retrieval)')
  .option('--pattern <keyword>', 'Mark all messages containing keyword')
  .option('--id <message_id>', 'Mark specific message by ID')
  .action(markMeta);

program
  .command('purge-meta')
  .description('Purge polluted memories by marking K.Y.T. system discussions as meta')
  .action(purgeMeta);

program.parse(process.argv);
