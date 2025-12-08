-- Enable Row Level Security on messages table
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only view their own messages
CREATE POLICY "Users can view their own messages"
ON messages FOR SELECT
USING (
  auth.uid() = user_id
);

-- Policy: Users can insert their own messages
-- We check that the user_id provided matches their auth.uid()
-- OR if user_id is null, it will default to auth.uid() (see below)
CREATE POLICY "Users can insert their own messages"
ON messages FOR INSERT
WITH CHECK (
  auth.uid() = user_id
);

-- Policy: Users can update their own messages
CREATE POLICY "Users can update their own messages"
ON messages FOR UPDATE
USING (
  auth.uid() = user_id
);

-- Policy: Users can delete their own messages
CREATE POLICY "Users can delete their own messages"
ON messages FOR DELETE
USING (
  auth.uid() = user_id
);

-- Set default value for user_id to be the current authenticated user
ALTER TABLE messages 
ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Grant access to authenticated users
GRANT ALL ON messages TO authenticated;
GRANT ALL ON messages TO service_role;
