# Preference Lookup Skill

You can look up user preferences that K.Y.T. has extracted from past conversations across all platforms.

## When to Use This Skill

Use preference lookup when the user:
- Asks "What's my favorite X?"
- Needs a recommendation based on past stated preferences
- References something they've expressed an opinion about before
- Asks about their own habits, routines, or choices

## How It Works

Preferences are automatically extracted from conversations by the K.Y.T. entity extraction pipeline. They are categorized by topic (e.g., "car", "movie", "programming-language", "editor", "food").

## Search Strategy

### Step 1: Direct Preference Lookup
Call `get_preferences` with the category extracted from the user's question.

Category extraction rules:
- "favorite movie" → category: "movie"
- "preferred programming language" → category: "programming-language"
- "what car do I drive" → category: "car"
- "my go-to editor" → category: "editor"
- Strip qualifiers: "of all time", "ever", "in the world" → just the base category

### Step 2: Fallback to Memory Search
If `get_preferences` returns nothing, fall back to `query_memory` with a preference-focused query like "preference for {category}" or "favorite {category}".

### Step 3: Entity Graph Walk
If both above fail, try `search_entities` with the category term — the preference might be captured as an entity relationship rather than a standalone preference record.

## Presentation

- State the preference clearly: "Based on your past conversations, your favorite X is Y"
- Include when/where it was mentioned: "You mentioned this in a ChatGPT conversation on 2026-01-15"
- If multiple conflicting preferences exist, present all and note the most recent one
- If nothing found, say so honestly — don't guess
