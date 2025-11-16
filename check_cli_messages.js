import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Query for CLI messages
const { data, error } = await supabase
  .from('messages')
  .select('*')
  .eq('source', 'cli')
  .order('timestamp', { ascending: false });

if (error) {
  console.error('❌ Error:', error);
} else {
  console.log(`✅ Found ${data.length} CLI message(s) in Supabase:\n`);

  data.forEach(msg => {
    console.log(`📝 ID: ${msg.message_id}`);
    console.log(`   Content: ${msg.content}`);
    console.log(`   Timestamp: ${new Date(msg.timestamp).toLocaleString()}`);
    console.log(`   Source: ${msg.source}`);
    console.log(`   Has embedding: ${msg.embedding ? 'Yes (1536 dimensions)' : 'No'}`);
    console.log('');
  });
}
