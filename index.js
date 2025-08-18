import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { Pool } from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render PG uses SSL
});

async function init() {
  const client = await pool.connect();
  try {
    const schema = readFileSync('./schema.sql', 'utf8');
    await client.query(schema);

    // Ensure a default profile exists
    const { rows } = await client.query(
      "SELECT id FROM profiles ORDER BY id LIMIT 1;"
    );
    if (rows.length === 0) {
      await client.query("INSERT INTO profiles (name, birth_year) VALUES ('Me', NULL);");
    }
    console.log('DB ready ✅');
  } finally {
    client.release();
  }
}
init().catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Save answer (primary endpoint)
app.post('/save-answer', async (req, res) => {
  const { question, text } = req.body || {};
  if (!question || !text) return res.status(400).json({ error: 'question and text are required' });

  const client = await pool.connect();
  try {
    const prof = await client.query("SELECT id FROM profiles ORDER BY id LIMIT 1;");
    const profileId = prof.rows[0].id;
    const result = await client.query(
      "INSERT INTO answers (profile_id, question, answer_text) VALUES ($1, $2, $3) RETURNING id, created_at;",
      [profileId, question, text]
    );
    res.json({ id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// --- Aliases so frontend can hit multiple possible paths ---
app.post(['/saveAnswer', '/answers', '/api/answers', '/api/saveAnswer', '/intake/answers', '/v1/answer'], async (req, res) => {
  // Just forward to the main handler
  req.url = '/save-answer';
  app._router.handle(req, res, () => {});
});

// Chat (echo + simple retrieval)
app.post('/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const client = await pool.connect();
  try {
    // naive retrieval: latest 3 answers that fuzzy-match any word
    const q = `
      SELECT question, answer_text
      FROM answers
      WHERE answer_text ILIKE '%' || $1 || '%'
         OR question ILIKE '%' || $1 || '%'
      ORDER BY created_at DESC
      LIMIT 3;
    `;
    const { rows } = await client.query(q, [message.split(/\s+/)[0] || message]);

    const snippets = rows.map(r => `• Q: ${r.question}\n  A: ${r.answer_text}`).join('\n');
    const disclosure = "AI reconstruction based on your recorded words (demo – no AI yet).";

    const reply = rows.length
      ? `You asked: "${message}".\nHere are bits I found from your saved words:\n${snippets}\n\n${disclosure}`
      : `You asked: "${message}". I don’t see anything related yet. Add more answers!\n\n${disclosure}`;

    res.json({ answer: reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});
// List recent answers (for sanity check)
app.get('/answers', async (_req, res) => {
  const client = await pool.connect();
  try {
    const q = `
      SELECT question, answer_text, created_at
      FROM answers
      ORDER BY created_at DESC
      LIMIT 100;
    `;
    const { rows } = await client.query(q);
    res.json({ items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// Count answers
app.get('/answers/count', async (_req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM answers;');
    res.json({ count: rows[0].count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// Export JSON
app.get('/export/json', async (_req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT question, answer_text, created_at FROM answers ORDER BY created_at ASC;'
    );
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="wid_answers.json"');
    res.send(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// Export CSV
app.get('/export/csv', async (_req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT question, answer_text, created_at FROM answers ORDER BY created_at ASC;'
    );
    const header = 'question,answer_text,created_at\n';
    const escape = (s='') => `"${String(s).replaceAll('"', '""')}"`;
    const csv = header + rows.map(r =>
      [r.question, r.answer_text, r.created_at.toISOString()].map(escape).join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="wid_answers.csv"');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// Render provides PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on :${PORT}`));
