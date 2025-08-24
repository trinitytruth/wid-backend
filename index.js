import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import OpenAI from 'openai';

const app = express();

// CORS: explicitly allow custom headers + methods
app.use(cors({
  origin: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Profile-Id','X-Profile-Name']
}));
app.use(express.json({ limit: '1mb' }));

/* ---------------- DB ---------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render PG uses SSL
});

/* ---------------- OpenAI ---------------- */
const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
const openai = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function embedText(text) {
  if (!openai) throw new Error('no_openai_key');
  const input = String(text || '').slice(0, 3000);
  const resp = await openai.embeddings.create({ model: 'text-embedding-3-small', input });
  return resp.data[0].embedding; // number[]
}
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

/* ---------------- Helpers ---------------- */
function getProfileId(req) {
  // Express normalizes header names, but be defensive
  const raw =
    req.get('x-profile-id') ||
    req.get('X-Profile-Id') ||
    (req.headers && (req.headers['x-profile-id'] || req.headers['X-Profile-Id']));
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('missing profile id');
    err.status = 401;
    throw err;
  }
  return id;
}

async function ensureProfileExists(client, id) {
  const { rows } = await client.query('SELECT id FROM profiles WHERE id = $1 LIMIT 1;', [id]);
  if (!rows.length) {
    const err = new Error('invalid profile id');
    err.status = 401;
    throw err;
  }
  return id;
}

/* ---------------- DB init ---------------- */
async function init() {
  const client = await pool.connect();
  try {
    const schema = readFileSync('./schema.sql', 'utf8');
    await client.query(schema);

    // Optional: ensure there is at least one profile (legacy)
    const { rows } = await client.query('SELECT id FROM profiles ORDER BY id LIMIT 1;');
    if (rows.length === 0) {
      await client.query("INSERT INTO profiles (name, birth_year, pin) VALUES ('Me', NULL, '0000');");
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

/* ---------------- Health & debug ---------------- */
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug/openai', (_req, res) => res.json({ hasKey: hasOpenAI }));

/* ---------------- Save Answer (writes embedding) ---------------- */
async function saveAnswerCore(client, { question, text, profileId }) {
  await ensureProfileExists(client, profileId);

  const result = await client.query(
    `INSERT INTO answers (profile_id, question, answer_text)
     VALUES ($1, $2, $3)
     RETURNING id, created_at, profile_id;`,
    [profileId, question, text]
  );
  const answerId = result.rows[0].id;

  // Best-effort embedding (don’t fail the request if this errors)
  try {
    if (openai) {
      const emb = await embedText(text);
      await client.query(
        `INSERT INTO answer_embeddings (answer_id, content, embedding)
         VALUES ($1, $2, $3)
         ON CONFLICT (answer_id) DO UPDATE
           SET content = EXCLUDED.content,
               embedding = EXCLUDED.embedding,
               updated_at = NOW();`,
        [answerId, text, JSON.stringify(emb)]
      );
    }
  } catch (e2) {
    console.error('embedding_failed', e2?.response?.data || e2);
  }

  return { id: answerId, created_at: result.rows[0].created_at };
}

/* Primary endpoint the frontend uses */
app.post('/save-answer', async (req, res) => {
  const { question, text } = req.body || {};
  if (!question || !text) return res.status(400).json({ error: 'question and text are required' });

  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const out = await saveAnswerCore(client, { question, text, profileId: pid });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

/* Back-compat aliases (require profile header now) */
app.post(
  ['/saveAnswer', '/answers', '/api/answers', '/api/saveAnswer', '/intake/answers', '/v1/answer'],
  async (req, res) => {
    const { question, text, question_id, response_text } = req.body || {};
    const q = question || (question_id ? String(question_id) : '');
    const t = text || response_text;
    if (!q || !t) return res.status(400).json({ error: 'question and text are required' });

    const client = await pool.connect();
    try {
      const pid = await ensureProfileExists(client, getProfileId(req));
      const out = await saveAnswerCore(client, { question: q, text: t, profileId: pid });
      res.json(out);
    } catch (e) {
      console.error(e);
      res.status(e.status || 500).json({ error: e.message || 'db_error' });
    } finally {
      client.release();
    }
  }
);

/* ---------------- Chat (RAG + tone controls) ---------------- */
app.post('/chat', async (req, res) => {
  const { message, tone } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const disclosure = "AI reconstruction based on your recorded words.";
  const client = await pool.connect();

  const formality = typeof tone?.formality === 'number' ? tone.formality : 0.5;
  const detail    = typeof tone?.detail === 'number'    ? tone.detail    : 0.5;
  const humor     = typeof tone?.humor === 'number'     ? tone.humor     : 0.5;

  try {
    if (!openai) throw new Error('no_openai_key');

    const pid = await ensureProfileExists(client, getProfileId(req));

    // 1) Embed the query
    const qEmb = await embedText(message);

    // 2) Retrieve THIS PROFILE'S answers + embeddings
    const { rows } = await client.query(
      `SELECT a.id, a.question, a.answer_text, e.embedding
         FROM answers a
         JOIN answer_embeddings e ON e.answer_id = a.id
        WHERE a.profile_id = $1
        ORDER BY a.created_at DESC
        LIMIT 200;`,
      [pid]
    );

    // 3) Score by cosine similarity
    const scored = rows.map(r => {
      const emb = Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding);
      return { ...r, score: cosineSim(qEmb, emb) };
    }).sort((x, y) => y.score - x.score);

    const top = scored.slice(0, 5).filter(r => r.score > 0.1);
    if (!top.length) {
      return res.json({ answer: `I’m not sure I captured this while I was alive.\n\n${disclosure}` });
    }

    // 4) Build prompt with tone guidance
    const context = top.map((r, i) =>
      `[#${i + 1} · score=${r.score.toFixed(3)}]
Q: ${r.question}
A: ${r.answer_text}`
    ).join('\n\n');

    const toneHints = [
      `Formality: ${formality} (0=Casual, 1=Formal)`,
      `Detail: ${detail} (0=Concise, 1=Story-rich)`,
      `Humor: ${humor} (0=Serious, 1=Playful)`
    ].join(' · ');

    const system = [
      "You are an AI reconstruction that MUST answer ONLY using the provided excerpts.",
      "Use first-person singular as the person, and do not invent new facts.",
      "Be warm and clear. If uncertain, say so.",
      `Match tone settings → ${toneHints}.`,
      `Always end with: "${disclosure}"`
    ].join(' ');

    const userPrompt = [
      `User question: ${message}`,
      "",
      "Excerpts (evidence):",
      context,
      "",
      "Synthesize a short answer in the person's voice using only the excerpts.",
      'If evidence is insufficient, say: "I’m not sure I captured this while I was alive."',
      `End with exactly: "${disclosure}"`
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 300
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      `I’m not sure I captured this while I was alive.\n\n${disclosure}`;

    return res.json({
      answer,
      citations: top.map((r, i) => ({ idx: i + 1, question: r.question, score: r.score }))
    });

  } catch (e) {
    // Fallback simple retrieval within THIS profile so chat never breaks
    console.warn('chat_fallback', e?.message || e);
    try {
      const pid = getProfileId(req); // may throw 401
      const { rows } = await client.query(
        `SELECT question, answer_text
           FROM answers
          WHERE profile_id = $1
            AND (answer_text ILIKE '%' || $2 || '%' OR question ILIKE '%' || $2 || '%')
          ORDER BY created_at DESC
          LIMIT 3;`,
        [pid, (message.split(/\s+/)[0] || message)]
      );
      const snippets = rows.map(r => `• Q: ${r.question}\n  A: ${r.answer_text}`).join('\n');
      const reply = rows.length
        ? `You asked: "${message}".\nHere are bits I found from your saved words:\n${snippets}\n\n${disclosure}`
        : `You asked: "${message}". I don’t see anything related yet. Add more answers!\n\n${disclosure}`;
      return res.json({ answer: reply });
    } catch (e2) {
      console.error(e2);
      return res.status(e2.status || 500).json({ error: e2.message || 'db_error' });
    }
  } finally {
    client.release();
  }
});

/* ---------------- Review & Export (scoped) ---------------- */
app.get('/answers', async (req, res) => {
  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows } = await client.query(
      `SELECT id, question, answer_text, created_at, updated_at
         FROM answers
        WHERE profile_id = $1
        ORDER BY created_at DESC
        LIMIT 100;`,
      [pid]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

app.get('/answers/count', async (req, res) => {
  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS count FROM answers WHERE profile_id = $1;',
      [pid]
    );
    res.json({ count: rows[0].count });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

app.get('/export/json', async (req, res) => {
  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows } = await client.query(
      'SELECT question, answer_text, created_at FROM answers WHERE profile_id = $1 ORDER BY created_at ASC;',
      [pid]
    );
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="wid_answers.json"');
    res.send(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

app.get('/export/csv', async (req, res) => {
  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows } = await client.query(
      'SELECT question, answer_text, created_at FROM answers WHERE profile_id = $1 ORDER BY created_at ASC;',
      [pid]
    );
    const header = 'question,answer_text,created_at\n';
    const escape = (s = '') => `"${String(s).replaceAll('"', '""')}"`;
    const csv =
      header +
      rows
        .map(r =>
          [r.question, r.answer_text, new Date(r.created_at).toISOString()]
            .map(escape)
            .join(',')
        )
        .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="wid_answers.csv"');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

/* ---------------- Reindex embeddings (scoped) ---------------- */
app.post('/reindex', async (req, res) => {
  if (!openai) return res.status(400).json({ error: 'OPENAI_API_KEY not set' });
  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows } = await client.query(
      `SELECT a.id, a.answer_text
         FROM answers a
    LEFT JOIN answer_embeddings e ON e.answer_id = a.id
        WHERE a.profile_id = $1 AND e.answer_id IS NULL
        ORDER BY a.created_at ASC
        LIMIT 100;`,
      [pid]
    );
    let ok = 0, fail = 0;
    for (const r of rows) {
      try {
        const emb = await embedText(r.answer_text);
        await client.query(
          `INSERT INTO answer_embeddings (answer_id, content, embedding)
           VALUES ($1, $2, $3)
           ON CONFLICT (answer_id) DO UPDATE
             SET content = EXCLUDED.content,
                 embedding = EXCLUDED.embedding,
                 updated_at = NOW();`,
          [r.id, r.answer_text, JSON.stringify(emb)]
        );
        ok++;
      } catch (e) {
        fail++;
        console.error('reindex_failed', r.id, e?.response?.data || e);
      }
    }
    res.json({ indexed: ok, failed: fail, remainingHint: rows.length >= 100 ? 'run again to index more' : 'complete' });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

/* ---------------- Profiles: upsert ---------------- */
// Body: { name: string, pin: string } -> returns { profile_id, name }
app.post('/profiles/upsert', async (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin are required' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'pin must be 4 digits' });

  const client = await pool.connect();
  try {
    const found = await client.query(
      `SELECT id, name, pin FROM profiles WHERE name = $1 LIMIT 1;`,
      [name]
    );
    if (found.rows.length) {
      const row = found.rows[0];
      if (row.pin !== pin) return res.status(403).json({ error: 'wrong pin' });
      return res.json({ profile_id: row.id, name: row.name });
    }
    const created = await client.query(
      `INSERT INTO profiles (name, birth_year, pin)
       VALUES ($1, NULL, $2)
       RETURNING id, name;`,
      [name, pin]
    );
    return res.json({ profile_id: created.rows[0].id, name: created.rows[0].name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

/* ---------------- Edit/Delete (ownership enforced, with debug) ---------------- */
app.put('/answers/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { text } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows: ownerRows } = await client.query('SELECT profile_id FROM answers WHERE id = $1 LIMIT 1;', [id]);
    const owner = ownerRows[0]?.profile_id ?? null;
    if (owner == null) return res.status(404).json({ error: 'not_found' });
    if (owner !== pid) {
      return res.status(403).json({
        error: 'forbidden',
        reason: 'owner mismatch',
        providedProfileId: pid,
        rowOwnerProfileId: owner
      });
    }

    await client.query(
      `UPDATE answers SET answer_text = $1, updated_at = now() WHERE id = $2;`,
      [text, id]
    );

    // Update embedding (best-effort)
    try {
      if (openai) {
        const emb = await embedText(text);
        await client.query(
          `INSERT INTO answer_embeddings (answer_id, content, embedding)
           VALUES ($1, $2, $3)
           ON CONFLICT (answer_id) DO UPDATE
             SET content = EXCLUDED.content,
                 embedding = EXCLUDED.embedding,
                 updated_at = NOW();`,
          [id, text, JSON.stringify(emb)]
        );
      }
    } catch (e2) {
      console.error('embedding_update_failed', e2?.response?.data || e2);
    }

    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

app.delete('/answers/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

  const client = await pool.connect();
  try {
    const pid = await ensureProfileExists(client, getProfileId(req));
    const { rows: ownerRows } = await client.query('SELECT profile_id FROM answers WHERE id = $1 LIMIT 1;', [id]);
    const owner = ownerRows[0]?.profile_id ?? null;
    if (owner == null) return res.status(404).json({ error: 'not_found' });
    if (owner !== pid) {
      return res.status(403).json({
        error: 'forbidden',
        reason: 'owner mismatch',
        providedProfileId: pid,
        rowOwnerProfileId: owner
      });
    }

    await client.query('DELETE FROM answers WHERE id = $1;', [id]);
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'db_error' });
  } finally {
    client.release();
  }
});

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on :${PORT}`));
