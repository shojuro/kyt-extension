import { getSupabaseClient } from '../lib/supabase-client.js';

export async function queryCosts({ days = 7, groupBy = 'provider' }) {
  const supabase = getSupabaseClient();

  // Validate groupBy
  const validGroups = ['provider', 'operation', 'edge_function', 'user', 'model'];
  if (!validGroups.includes(groupBy)) {
    return {
      content: [{ type: 'text', text: `Error: groupBy must be one of: ${validGroups.join(', ')}` }],
      isError: true,
    };
  }

  // Fetch summary
  const { data: summary, error: summaryErr } = await supabase.rpc('get_cost_summary', {
    p_days: days,
    p_group_by: groupBy,
  });

  if (summaryErr) {
    return {
      content: [{ type: 'text', text: `Error querying cost summary: ${summaryErr.message}` }],
      isError: true,
    };
  }

  // Fetch timeseries
  const { data: timeseries, error: tsErr } = await supabase.rpc('get_cost_timeseries', {
    p_days: days,
    p_group_by: groupBy,
  });

  // Fetch fixed costs
  const { data: fixedCosts } = await supabase
    .from('fixed_costs')
    .select('name, provider, monthly_cost_usd, start_date, end_date, notes')
    .is('end_date', null)
    .order('monthly_cost_usd', { ascending: false });

  // Format summary table
  let output = `## Cost Summary (last ${days} days, grouped by ${groupBy})\n\n`;
  output += '| Group | Requests | Input Tokens | Output Tokens | Cost (USD) |\n';
  output += '|-------|----------|-------------|---------------|------------|\n';

  let totalCost = 0;
  let totalRequests = 0;
  for (const row of (summary || [])) {
    totalCost += parseFloat(row.total_cost_usd || 0);
    totalRequests += parseInt(row.request_count || 0);
    output += `| ${row.group_key} | ${Number(row.request_count).toLocaleString()} | ${Number(row.total_input_tokens).toLocaleString()} | ${Number(row.total_output_tokens).toLocaleString()} | $${parseFloat(row.total_cost_usd).toFixed(4)} |\n`;
  }
  output += `| **Total** | **${totalRequests.toLocaleString()}** | | | **$${totalCost.toFixed(4)}** |\n`;

  // Fixed costs section
  if (fixedCosts && fixedCosts.length > 0) {
    output += '\n## Active Fixed Monthly Costs\n\n';
    output += '| Name | Provider | Monthly (USD) | Since | Notes |\n';
    output += '|------|----------|--------------|-------|-------|\n';
    let fixedTotal = 0;
    for (const fc of fixedCosts) {
      fixedTotal += parseFloat(fc.monthly_cost_usd);
      output += `| ${fc.name} | ${fc.provider} | $${parseFloat(fc.monthly_cost_usd).toFixed(2)} | ${fc.start_date} | ${fc.notes || ''} |\n`;
    }
    output += `| **Total Fixed** | | **$${fixedTotal.toFixed(2)}/mo** | | |\n`;
  }

  // Daily trend (last 5 days max)
  if (!tsErr && timeseries && timeseries.length > 0) {
    const days5 = timeseries.slice(0, 25); // ~5 days * 5 groups max
    const byDay = {};
    for (const row of days5) {
      if (!byDay[row.day]) byDay[row.day] = [];
      byDay[row.day].push(row);
    }
    output += '\n## Daily Trend (recent)\n\n';
    output += '| Date | Group | Requests | Cost (USD) |\n';
    output += '|------|-------|----------|------------|\n';
    for (const [day, rows] of Object.entries(byDay).slice(0, 5)) {
      for (const row of rows) {
        output += `| ${day} | ${row.group_key} | ${Number(row.request_count).toLocaleString()} | $${parseFloat(row.total_cost_usd).toFixed(4)} |\n`;
      }
    }
  }

  return {
    content: [{ type: 'text', text: output }],
  };
}
