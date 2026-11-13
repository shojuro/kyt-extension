# Memory Search Skill

You have access to K.Y.T. (Keep Your Thoughts), a cross-platform conversation memory system. It indexes conversations from ChatGPT, Claude web, Claude Code, and Google Gemini.

## When to Use This Skill

Use memory search when the user:
- Asks about something they've discussed before ("What did I say about X?")
- References a past decision or preference
- Mentions a person, project, or concept that might be in their history
- Asks a personal question that conversation history could answer

## Search Strategy

### Step 1: Direct Search
Call `query_memory` with the user's query. Use `useHyde: true` for semantic expansion (slower but better recall).

### Step 2: Entity Search (if Step 1 returns < 2 results)
Call `search_entities` with key nouns from the query. Entities capture people, projects, technologies, and concepts across all conversations.

### Step 3: Rephrase and Retry (if Steps 1-2 return nothing)
Try alternative phrasings:
- Synonyms ("car" → "vehicle", "favorite" → "preference")
- Broader terms ("React hook" → "React" or "frontend")
- Platform-specific ("gemini voice" if the user mentioned speaking to Gemini)

### Step 4: Preference Check (for preference-type queries)
If the query is about preferences ("favorite movie", "preferred editor"), call `get_preferences` with the category.

## Important Rules

- **Always search before saying "I don't know"** — the information might be in memory
- **Report confidence honestly** — don't embellish low-confidence matches
- **Cite the platform and date** — helps the user verify and contextualize
- **Try multiple approaches** — one failed search doesn't mean the memory doesn't exist
- **Never fabricate memories** — only report what the search actually returned
