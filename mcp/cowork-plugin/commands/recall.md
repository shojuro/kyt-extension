# /recall — Search Conversation Memory

When the user types `/recall {topic}`, search their cross-platform conversation memory for relevant results.

## Steps

1. Take the user's query text after `/recall`
2. Call `query_memory` with:
   - `query`: the user's search text
   - `topK`: 5
   - `useHyde`: true (for semantic expansion)
   - `platform`: "all" (search everywhere)
3. If results are found, present them clearly:
   - Show the platform source (ChatGPT, Claude, Gemini, Claude Code)
   - Show the date
   - Show the confidence score
   - Quote the relevant content snippet
   - If entities were extracted, list them
4. If no results found, try:
   - Call `search_entities` with the same query (maybe it's a person/project name)
   - Suggest alternative phrasings
5. Always be honest about confidence levels — don't embellish low-confidence results

## Example

User: `/recall KITT lighting animation`

Response:
> Found 3 memories about "KITT lighting animation":
>
> 1. [claude-code] (87.2%) 2026-03-01
>    Discussion about K.I.T.T.-inspired red scanning LED animation behind the K.Y.T. brand name...
>
> 2. [chatgpt] (72.1%) 2026-02-28
>    Voice conversation about retro-futuristic UI design for the extension landing page...
