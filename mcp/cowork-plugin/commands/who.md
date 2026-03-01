# /who — Entity Lookup

When the user types `/who {name}`, search the knowledge graph for a person, project, technology, or concept.

## Steps

1. Take the name/term after `/who`
2. Call `search_entities` with:
   - `query`: the user's search term
   - `limit`: 5
3. For each entity found, present:
   - Entity name and type (PERSON, PROJECT, TECH, CONCEPT, PLACE, ORG)
   - Number of mentions across conversations
   - Related entities (if the knowledge graph has connections)
   - A brief context snippet from the most relevant mention
4. If no entity found, fall back to `query_memory` with the same term — it might appear in conversation content without being extracted as a named entity
5. If still nothing, say so honestly and suggest the user save context about this entity with `/remember`

## Example

User: `/who Jennifer`

Response:
> **Jennifer** (PERSON) — 12 mentions across 4 conversations
> Context: Personal trainer, helped with deadlift form and training schedule
> Related entities: fitness, gym, training program
> First mentioned: 2026-01-15 (ChatGPT)
> Last mentioned: 2026-02-28 (Gemini voice)
