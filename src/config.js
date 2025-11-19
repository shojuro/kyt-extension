/**
 * KYT Day 2: Configuration Module
 *
 * Centralizes environment configuration and API client initialization
 * Validates required environment variables
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Validate environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'OPENAI_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Export configuration
export const config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  embedding: {
    model: 'text-embedding-3-small',
    dimensions: 1536
  },
  sync: {
    batchSize: 100, // Messages per batch for embedding generation
    maxRetries: 3
  },
  search: {
    defaultLimit: 5,
    defaultThreshold: 0.5,
    disableQueryTransformation: process.env.DISABLE_QUERY_TRANSFORMATION === 'true'
  }
};

// Initialize and export clients
export const supabase = createClient(
  config.supabase.url,
  config.supabase.anonKey
);

export const openai = new OpenAI({
  apiKey: config.openai.apiKey
});

// Export validation function
export function validateConfig() {
  const missing = requiredEnvVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    return {
      valid: false,
      missing: missing
    };
  }

  return {
    valid: true,
    config: {
      supabaseUrl: config.supabase.url,
      hasOpenAIKey: !!config.openai.apiKey,
      embeddingModel: config.embedding.model
    }
  };
}
