# /remember — Save a Note to Memory

When the user types `/remember {content}`, save the content as a persistent note in K.Y.T. memory.

## Steps

1. Take everything after `/remember` as the note content
2. Identify any natural tags from the content (topics, project names, people mentioned)
3. Call `save_note` with:
   - `content`: the user's note text
   - `tags`: auto-extracted tags (keep to 3-5 max)
4. Confirm what was saved and what tags were applied
5. Let the user know the note will be searchable via `/recall` after embedding generation

## Guidelines

- Notes should capture **decisions**, **preferences**, **facts**, or **context** the user wants to remember
- Don't save trivial or transient information unless the user explicitly asks
- If the content is ambiguous, ask the user to clarify before saving

## Example

User: `/remember Always use bun instead of npm for this project. The team agreed on 2026-02-15.`

Response:
> Saved to K.Y.T. memory with tags: [bun, npm, team-decision]
> This will be searchable across all your Claude sessions.
