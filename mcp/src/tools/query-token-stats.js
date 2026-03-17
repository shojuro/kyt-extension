import { getSupabaseClient, getUserId } from '../lib/supabase-client.js';

export async function queryTokenStats({ days = 30, groupBy = 'platform' }) {
  const supabase = getSupabaseClient();
  const userId = getUserId();

  // Validate groupBy
  const validGroups = ['platform', 'speaker', 'month'];
  if (!validGroups.includes(groupBy)) {
    return {
      content: [{ type: 'text', text: `Error: groupBy must be one of: ${validGroups.join(', ')}` }],
      isError: true,
    };
  }

  // Fetch token stats via RPC
  const { data: stats, error: statsErr } = await supabase.rpc('get_token_stats', {
    p_user_id: userId,
    p_days: days,
    p_group_by: groupBy,
  });

  if (statsErr) {
    return {
      content: [{ type: 'text', text: `Error querying token stats: ${statsErr.message}` }],
      isError: true,
    };
  }

  // Fetch coverage: total rows vs counted rows
  const { count: totalRows } = await supabase
    .from('chat_turns')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const { count: countedRows } = await supabase
    .from('chat_turns')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('token_count', 'is', null);

  const coverage = totalRows > 0 ? ((countedRows / totalRows) * 100).toFixed(1) : '0.0';
  const remaining = totalRows - countedRows;

  // Format output
  let output = `## Token Count Stats (last ${days} days, grouped by ${groupBy})\n\n`;
  output += `**Coverage**: ${countedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows counted (${coverage}%)`;
  if (remaining > 0) {
    output += ` — ${remaining.toLocaleString()} remaining`;
  }
  output += '\n\n';

  if (!stats || stats.length === 0) {
    output += '_No token count data available yet. Run backfill to populate._\n';
  } else {
    output += '| Group | Turns | Total Tokens | Avg Tokens | Max | Min |\n';
    output += '|-------|-------|-------------|------------|-----|-----|\n';

    let grandTotal = 0;
    let grandTurns = 0;
    for (const row of stats) {
      grandTotal += Number(row.total_tokens);
      grandTurns += Number(row.turn_count);
      output += `| ${row.group_key} | ${Number(row.turn_count).toLocaleString()} | ${Number(row.total_tokens).toLocaleString()} | ${Number(row.avg_tokens).toFixed(1)} | ${row.max_tokens} | ${row.min_tokens} |\n`;
    }
    output += `| **Total** | **${grandTurns.toLocaleString()}** | **${grandTotal.toLocaleString()}** | **${(grandTotal / grandTurns).toFixed(1)}** | | |\n`;
  }

  return {
    content: [{ type: 'text', text: output }],
  };
}
