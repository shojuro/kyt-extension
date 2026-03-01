# /digest — Memory Digest

When the user types `/digest`, provide a summary of recent conversation memories across platforms.

## Steps

1. Run multiple `query_memory` searches to build a cross-platform snapshot:
   - `query_memory({ query: "recent decisions and preferences", topK: 3, platform: "chatgpt" })`
   - `query_memory({ query: "recent decisions and preferences", topK: 3, platform: "claude" })`
   - `query_memory({ query: "recent decisions and preferences", topK: 3, platform: "claude-code" })`
   - `query_memory({ query: "recent decisions and preferences", topK: 3, platform: "gemini" })`
2. Group results by platform
3. For each platform, summarize the most recent topics discussed
4. Call `search_entities` with a broad query like "recent" to surface active entities
5. Present a clean digest:
   - Platform breakdown (how many memories per platform)
   - Top topics across platforms
   - Key entities (people, projects, technologies) that appeared recently
   - Any preferences that were captured

## Example Output

> **K.Y.T. Memory Digest**
>
> **ChatGPT** (3 recent) — UI/UX design discussion, KITT animation concept, landing page wireframes
> **Claude Code** (3 recent) — SSR capture fix, Gemini platform integration, MCP server setup
> **Gemini** (2 recent) — Voice conversation about project planning, API architecture
>
> **Active Entities:** K.Y.T., KITT animation, Supabase, MCP, Gemini platform
> **Recent Preferences:** Dark mode UI, bun over npm
