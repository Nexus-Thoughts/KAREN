#!/usr/bin/env node
// scripts/reindex-knowledge.mjs — Phase 16 (KAREN RAG).
//
// Chunks docs/*.md and embeds each chunk via Gemini's text-embedding-004
// (matching supabase/functions/karen-chat/providers/gemini.ts's embedText),
// then upserts into public.karen_knowledge_chunks via the ADMIN-gated
// karen_admin_upsert_knowledge_chunk RPC (20260101002400_karen_knowledge_rag.sql).
//
// Deliberately NOT run inside karen-chat's request path (ADR-004: no
// long-running work inline in a chat turn) and deliberately NOT using the
// Supabase service-role key even though this is offline tooling: the RPC
// checks cims.is_admin(), which is derived from auth.uid() — a service-role
// call has no auth.uid() and would be rejected exactly like an
// unauthenticated one. This script signs in as a real admin user for the
// same reason the rest of the app never uses service role (docs/13: no
// RBAC bypass anywhere, including operator tooling).
//
// Usage:
//   KAREN_REINDEX_ADMIN_EMAIL=admin@cims.test \
//   KAREN_REINDEX_ADMIN_PASSWORD='...' \
//   npm run karen:reindex
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY and KAREN_API_KEY
// from .env (same file the app itself uses) unless overridden by the shell
// environment. Safe to re-run: source_path/chunk_index is a stable key, so
// re-embedding after a docs/ edit updates chunks in place rather than
// duplicating them (verified by
// supabase/tests/database/013_phase16_knowledge_rag.test.sql).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Minimal .env loader (no `dotenv` dependency needed for one script): only
// fills in variables not already set in the real environment, so
// `KAREN_REINDEX_ADMIN_PASSWORD=... npm run karen:reindex` on the command
// line always wins over anything in the file.
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const GEMINI_API_KEY = process.env.KAREN_API_KEY;
const ADMIN_EMAIL = process.env.KAREN_REINDEX_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.KAREN_REINDEX_ADMIN_PASSWORD;
const DOCS_DIR = process.env.KAREN_REINDEX_DOCS_DIR || 'docs';
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 150;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) fail('VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set (check .env).');
if (!GEMINI_API_KEY) fail('KAREN_API_KEY is not set — a real Gemini API key (starts with "AIza", from https://aistudio.google.com/apikey) is required to compute embeddings.');
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  fail(
    'KAREN_REINDEX_ADMIN_EMAIL and KAREN_REINDEX_ADMIN_PASSWORD must be set to an ADMIN account\'s real credentials.\n' +
    '  e.g. KAREN_REINDEX_ADMIN_EMAIL=admin@cims.test KAREN_REINDEX_ADMIN_PASSWORD=... npm run karen:reindex\n' +
    '  (admin@cims.test / Cims!Local123 for a local/seeded database only — never in production).'
  );
}

// -----------------------------------------------------------------------------
// Chunking: split on blank-line paragraph boundaries first, then pack
// paragraphs up to ~CHUNK_CHARS with a small overlap so a fact split across
// a chunk boundary is still findable from either side. Simple and
// deterministic on purpose — this is documentation prose, not code, and a
// fancier splitter isn't worth the complexity for a few hundred chunks.
function chunkMarkdown(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > CHUNK_CHARS) {
      chunks.push(current);
      current = current.slice(Math.max(0, current.length - CHUNK_OVERLAP));
    }
    current = current ? `${current}\n\n${para}` : para;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function embed(text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini embeddings returned ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const values = data?.embedding?.values;
  if (!values?.length) throw new Error('Gemini embeddings returned no vector.');
  return values;
}

async function main() {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) fail(`No .md files found in "${DOCS_DIR}".`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`Signing in as ${ADMIN_EMAIL}...`);
  const { error: signInError } = await supabase.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (signInError) fail(`Sign-in failed: ${signInError.message}`);

  let totalChunks = 0;
  let totalDocs = 0;

  for (const file of files) {
    const sourcePath = `${DOCS_DIR}/${file}`;
    const raw = readFileSync(join(DOCS_DIR, file), 'utf-8');
    const firstHeading = raw.match(/^#\s+(.+)$/m);
    const title = firstHeading ? firstHeading[1].trim() : file;
    const chunks = chunkMarkdown(raw);

    console.log(`${sourcePath}: ${chunks.length} chunk(s)`);
    for (let i = 0; i < chunks.length; i++) {
      const vector = await embed(chunks[i]);
      const { error } = await supabase.rpc('karen_admin_upsert_knowledge_chunk', {
        p_source_path: sourcePath,
        p_title: title,
        p_chunk_index: i,
        p_content: chunks[i],
        p_embedding: JSON.stringify(vector),
      });
      if (error) fail(`Upserting ${sourcePath}#${i} failed: ${error.message}`);
      totalChunks += 1;
    }
    totalDocs += 1;
  }

  console.log(`\n✓ Indexed ${totalChunks} chunk(s) across ${totalDocs} document(s).`);
  await supabase.auth.signOut();
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
