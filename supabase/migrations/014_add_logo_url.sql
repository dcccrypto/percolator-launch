-- Add logo_url column to markets table
ALTER TABLE markets ADD COLUMN IF NOT EXISTS logo_url TEXT;
