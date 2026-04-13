-- Enable pgvector extension on database creation.
-- Runs automatically via PostgreSQL's /docker-entrypoint-initdb.d/ mechanism.
CREATE EXTENSION IF NOT EXISTS vector;
