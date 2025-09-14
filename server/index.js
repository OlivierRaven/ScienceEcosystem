// server/index.js
import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 5173,
  SESSION_SECRET = "dev-secret",
  ORCID_BASE = "https://orcid.org",
  ORCID_API_BASE = "https://api.orcid.org/v3.0",
  ORCID_CLIENT_ID,
  ORCID_CLIENT_SECRET,
  ORCID_REDIRECT_URI,
  STATIC_DIR = "../",
  NODE_ENV = "development",
  COOKIE_DOMAIN,                // optional: ".scienceecosystem.org"
  DATABASE_URL                  // Neon: postgresql://... ?sslmode=require
} = process.env;

if (!ORCID_CLIENT_ID || !ORCID_CLIENT_SECRET || !ORCID_REDIRECT_URI) {
  console.error("Missing ORCID env vars in .env");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var (Neon Postgres)");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

/* ---------------------------------
   Postgres (Neon) connection + DDL
----------------------------------*/
const pool = new Pool({ connectionString: DATABASE_URL });

async function pgInit() {
  // Core tables you already had
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      orcid TEXT PRIMARY KEY,
      name TEXT,
      affiliation TEXT
    );

    CREATE TABLE IF NOT EXISTS library_items (
      orcid TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY (orcid, id),
      CONSTRAINT fk_user FOREIGN KEY (orcid) REFERENCES users(orcid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      expires_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claimed_authors (
      orcid TEXT NOT NULL,
      author_id TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (orcid, author_id),
      CONSTRAINT fk_user2 FOREIGN KEY (orcid) REFERENCES users(orcid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS merged_claims (
      orcid TEXT NOT NULL,
      primary_author_id TEXT NOT NULL,
      merged_author_id  TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (orcid, primary_author_id, merged_author_id),
      CONSTRAINT fk_user3 FOREIGN KEY (orcid) REFERENCES users(orcid) ON DELETE CASCADE
    );
  `);

  // New: collections + collection_items
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collections (
      id SERIAL PRIMARY KEY,
      orcid TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES collections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      orcid TEXT NOT NULL,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      paper_id TEXT NOT NULL,
      PRIMARY KEY (orcid, collection_id, paper_id)
    );
  `);

  // New: notes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id BIGSERIAL PRIMARY KEY,
      orcid TEXT NOT NULL,
      paper_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Extend library_items with cached metadata columns (idempotent)
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS openalex_id  TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS openalex_url TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS doi         TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS year        INTEGER`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS venue       TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS authors     TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS cited_by    INTEGER`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS abstract    TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS pdf_url     TEXT`);
  await pool.query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS meta_fresh  BOOLEAN DEFAULT FALSE`);
}
await pgInit();

/* ---------------------------
   Session helpers (persistent)
----------------------------*/
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    secure: NODE_ENV === "production",
    path: "/",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  };
}
async function setSession(res, payload) {
  const sid = crypto.randomBytes(24).toString("hex");
  const expires = Date.now() + (30 * 24 * 60 * 60 * 1000);
  // Ensure JSONB gets valid JSON
  await pool.query(
    `INSERT INTO sessions (sid, data, expires_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
    [sid, JSON.stringify(payload), expires]
  );
  res.cookie("sid", sid, cookieOptions());
}
async function getSession(req) {
  const sid = req.signedCookies?.sid;
  if (!sid) return null;
  const { rows } = await pool.query(`SELECT data, expires_at FROM sessions WHERE sid = $1`, [sid]);
  if (!rows.length) return null;
  const row = rows[0];
  if (Number(row.expires_at) < Date.now()) {
    await pool.query(`DELETE FROM sessions WHERE sid = $1`, [sid]);
    return null;
  }
  // row.data is JSONB → JS object already, but normalize:
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
}
async function clearSession(req, res) {
  const sid = req.signedCookies?.sid;
  if (sid) await pool.query(`DELETE FROM sessions WHERE sid = $1`, [sid]);
  res.clearCookie("sid", cookieOptions());
}
setInterval(() => pool.query(`DELETE FROM sessions WHERE expires_at < $1`, [Date.now()]).catch(()=>{}), 12 * 60 * 60 * 1000);

function requireAuth(req, res) {
  return getSession(req).then(sess => {
    if (!sess) { res.status(401).json({ error: "Not signed in" }); return null; }
    return sess;
  });
}

/* ------------
   SQL helpers
-------------*/
async function upsertUser({ orcid, name, affiliation }) {
  await pool.query(
    `INSERT INTO users (orcid, name, affiliation)
     VALUES ($1, $2, $3)
     ON CONFLICT (orcid) DO UPDATE SET name = EXCLUDED.name, affiliation = EXCLUDED.affiliation`,
    [orcid, name, affiliation]
  );
}
async function getUser(orcid) {
  const { rows } = await pool.query(`SELECT orcid, name, affiliation FROM users WHERE orcid = $1`, [orcid]);
  return rows[0] || null;
}
async function libraryList(orcid) {
  const { rows } = await pool.query(`SELECT id, title FROM library_items WHERE orcid = $1 ORDER BY title`, [orcid]);
  return rows;
}
async function libraryAdd(orcid, id, title) {
  await pool.query(
    `INSERT INTO library_items (orcid, id, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (orcid, id) DO NOTHING`,
    [orcid, id, title]
  );
}
async function libraryDel(orcid, id) {
  await pool.query(`DELETE FROM library_items WHERE orcid = $1 AND id = $2`, [orcid, id]);
}
async function libraryClear(orcid) {
  await pool.query(`DELETE FROM library_items WHERE orcid = $1`, [orcid]);
}

// Claims/Merges
async function claimsList(orcid) {
  const claims = await pool.query(
    `SELECT author_id, verified, EXTRACT(EPOCH FROM created_at)::bigint AS created_at
     FROM claimed_authors WHERE orcid=$1 ORDER BY created_at DESC`, [orcid]);
  const merges = await pool.query(
    `SELECT primary_author_id, merged_author_id, EXTRACT(EPOCH FROM created_at)::bigint AS created_at
     FROM merged_claims WHERE orcid=$1 ORDER BY created_at DESC`, [orcid]);
  return { claims: claims.rows, merges: merges.rows };
}
async function claimAdd(orcid, author_id) {
  await pool.query(
    `INSERT INTO claimed_authors (orcid, author_id, verified)
     VALUES ($1, $2, FALSE)
     ON CONFLICT (orcid, author_id) DO NOTHING`,
    [orcid, author_id]
  );
}
async function claimDel(orcid, author_id) {
  await pool.query(`DELETE FROM claimed_authors WHERE orcid=$1 AND author_id=$2`, [orcid, author_id]);
}
async function mergeAdd(orcid, primary_id, merged_id) {
  await pool.query(
    `INSERT INTO merged_claims (orcid, primary_author_id, merged_author_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [orcid, primary_id, merged_id]
  );
}
async function mergeDel(orcid, primary_id, merged_id) {
  await pool.query(
    `DELETE FROM merged_claims WHERE orcid=$1 AND primary_author_id=$2 AND merged_author_id=$3`,
    [orcid, primary_id, merged_id]
  );
}

/* -----------------------------
   External APIs (OpenAlex/OA)
------------------------------*/
const OPENALEX = "https://api.openalex.org";
const UNPAYWALL_EMAIL = "scienceecosystem@icloud.com";

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(()=>r.statusText)}`);
  return r.json();
}
function invertAbstract(idx){
  const words = [];
  Object.keys(idx||{}).forEach(word => {
    for (const pos of idx[word]) words[pos] = word;
  });
  return words.join(" ");
}
async function hydrateWorkMeta(idTail) {
  const work = await fetchJSON(`${OPENALEX}/works/${encodeURIComponent(idTail)}`);

  // DOI → Unpaywall
  const doi = work.doi || work?.ids?.doi || null;
  let pdf_url = null;
  if (doi) {
    try {
      const doiClean = String(doi).replace(/^doi:/i,"");
      const up = await fetchJSON(`https://api.unpaywall.org/v2/${encodeURIComponent(doiClean)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`);
      const best = up.best_oa_location || null;
      pdf_url = best?.url_for_pdf || best?.url || null;
    } catch(_) {}
  }

  const authors = (work.authorships || [])
    .map(a => a?.author?.display_name)
    .filter(Boolean).join(", ");

  const venue = work?.host_venue?.display_name || work?.primary_location?.source?.display_name || null;

  return {
    openalex_id: idTail,
    openalex_url: work.id,
    doi: doi ? String(doi).replace(/^doi:/i,"") : null,
    title: work.display_name || work.title || "Untitled",
    year: work.publication_year ?? null,
    venue,
    authors,
    cited_by: work.cited_by_count ?? 0,
    abstract: work.abstract_inverted_index ? invertAbstract(work.abstract_inverted_index) : null,
    pdf_url,
    meta_fresh: true
  };
}

/* ---------------------------
   Health + static
----------------------------*/
app.get("/health", (_req, res) => res.type("text").send("ok"));

const staticRoot = path.resolve(__dirname, STATIC_DIR);
app.use(express.static(staticRoot, {
  extensions: ["html"],
  maxAge: NODE_ENV === "production" ? "1h" : 0
}));

/* ---------------------------
   ORCID OAuth
----------------------------*/
app.get("/auth/orcid/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: ORCID_CLIENT_ID,
    response_type: "code",
    scope: "/authenticate",
    redirect_uri: ORCID_REDIRECT_URI
  });
  return res.redirect(`${ORCID_BASE}/oauth/authorize?${params.toString()}`);
});

app.get("/auth/orcid/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`ORCID error: ${String(error_description || error)}`);
  if (!code) return res.status(400).send("Missing authorization code");

  const form = new URLSearchParams({
    client_id: ORCID_CLIENT_ID,
    client_secret: ORCID_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: ORCID_REDIRECT_URI
  });

  const tokenRes = await fetch(`${ORCID_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text().catch(() => "");
    return res.status(400).send(`Token exchange failed: ${tokenRes.status} ${t}`);
  }

  const token = await tokenRes.json();
  const orcid = token.orcid;
  if (!orcid) return res.status(400).send("Token response missing ORCID iD");

  // Fetch public profile (best-effort)
  let name = null, affiliation = null;
  try {
    const recRes = await fetch(`${ORCID_API_BASE}/${orcid}/record`, { headers: { Accept: "application/json" } });
    if (recRes.ok) {
      const rec = await recRes.json();
      const person = rec?.person;
      const given  = person?.name?.["given-names"]?.value || "";
      const family = person?.name?.["family-name"]?.value || "";
      const credit = person?.name?.["credit-name"]?.value || "";
      name = (credit || `${given} ${family}`).trim() || null;
      const emp = rec?.["activities-summary"]?.employments?.["employment-summary"]?.[0];
      affiliation = emp?.organization?.name || null;
    }
  } catch {}

  await upsertUser({ orcid, name, affiliation });
  await setSession(res, { orcid });
  res.redirect("/user-profile.html");
});

/* ---------------------------
   Auth + existing Library API
----------------------------*/
app.post("/auth/logout", async (req, res) => {
  await clearSession(req, res);
  res.status(204).end();
});

app.get("/api/me", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  const row = await getUser(sess.orcid);
  if (!row) return res.status(404).json({ error: "User not found" });
  res.json(row);
});

app.get("/api/library", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  res.json(await libraryList(sess.orcid));
});

app.post("/api/library", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  const { id, title } = req.body || {};
  if (!id || !title) return res.status(400).json({ error: "id and title required" });
  await libraryAdd(sess.orcid, String(id), String(title));
  res.status(201).json({ ok: true });
});

app.delete("/api/library/:id", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  await libraryDel(sess.orcid, String(req.params.id));
  res.status(204).end();
});

app.delete("/api/library", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  await libraryClear(sess.orcid);
  res.status(204).end();
});

/* ---------------------------
   NEW: Collections API
----------------------------*/
app.get("/api/collections", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const { rows } = await pool.query(
    `SELECT id, name, parent_id FROM collections WHERE orcid=$1 ORDER BY name`,
    [sess.orcid]
  );
  res.json(rows);
});

app.post("/api/collections", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const { name, parent_id } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (parent_id) {
    const p = await pool.query(`SELECT id FROM collections WHERE orcid=$1 AND id=$2`, [sess.orcid, Number(parent_id)]);
    if (!p.rowCount) return res.status(400).json({ error: "parent not found" });
  }
  const out = await pool.query(
    `INSERT INTO collections (orcid, name, parent_id) VALUES ($1,$2,$3)
     RETURNING id, name, parent_id`,
    [sess.orcid, String(name), parent_id ? Number(parent_id) : null]
  );
  res.status(201).json(out.rows[0]);
});

app.patch("/api/collections/:id", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const out = await pool.query(
    `UPDATE collections SET name=$1 WHERE orcid=$2 AND id=$3
     RETURNING id, name, parent_id`,
    [String(name), sess.orcid, Number(req.params.id)]
  );
  if (!out.rowCount) return res.status(404).json({ error: "not found" });
  res.json(out.rows[0]);
});

app.delete("/api/collections/:id", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  await pool.query(`DELETE FROM collections WHERE orcid=$1 AND id=$2`, [sess.orcid, Number(req.params.id)]);
  res.status(204).end();
});

/* ---------------------------
   NEW: Collection Items API
----------------------------*/
app.post("/api/collections/:id/items", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const cid = Number(req.params.id);
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "paper id required" });

  const col = await pool.query(`SELECT id FROM collections WHERE orcid=$1 AND id=$2`, [sess.orcid, cid]);
  if (!col.rowCount) return res.status(404).json({ error: "collection not found" });

  await pool.query(
    `INSERT INTO collection_items (orcid, collection_id, paper_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [sess.orcid, cid, String(id)]
  );
  res.status(201).json({ ok: true });
});

app.delete("/api/collections/:id/items/:paperId", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  await pool.query(
    `DELETE FROM collection_items WHERE orcid=$1 AND collection_id=$2 AND paper_id=$3`,
    [sess.orcid, Number(req.params.id), String(req.params.paperId)]
  );
  res.status(204).end();
});

/* ---------------------------
   NEW: Library full + membership
----------------------------*/
// --- replace the whole /api/library/full handler with this ---
app.get("/api/library/full", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;

  try {
    // Single round-trip: items + aggregated collection_ids
    const { rows } = await pool.query(
      `
      SELECT
        li.id,
        li.title,
        li.openalex_id,
        li.openalex_url,
        li.doi,
        li.year,
        li.venue,
        li.authors,
        li.cited_by,
        li.abstract,
        li.pdf_url,
        COALESCE(li.meta_fresh, FALSE) AS meta_fresh,
        COALESCE(ARRAY_AGG(ci.collection_id) FILTER (WHERE ci.collection_id IS NOT NULL), '{}') AS collection_ids
      FROM library_items li
      LEFT JOIN collection_items ci
        ON ci.orcid = li.orcid AND ci.paper_id = li.id
      WHERE li.orcid = $1
      GROUP BY
        li.id, li.title, li.openalex_id, li.openalex_url, li.doi, li.year,
        li.venue, li.authors, li.cited_by, li.abstract, li.pdf_url, li.meta_fresh
      ORDER BY li.title;
      `,
      [sess.orcid]
    );

    res.json(rows);
  } catch (e) {
    console.error("GET /api/library/full failed:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});


/* ---------------------------
   NEW: Refresh one item metadata
----------------------------*/
app.post("/api/items/:id/refresh", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const id = String(req.params.id);
  try {
    const idTail = id.replace(/^https?:\/\/openalex\.org\//i, "");
    const meta = await hydrateWorkMeta(idTail);

    const upd = await pool.query(
      `UPDATE library_items SET
        title=$1, openalex_id=$2, openalex_url=$3, doi=$4, year=$5, venue=$6,
        authors=$7, cited_by=$8, abstract=$9, pdf_url=$10, meta_fresh=TRUE
       WHERE orcid=$11 AND id=$12
       RETURNING id, title, openalex_id, openalex_url, doi, year, venue, authors, cited_by, abstract, pdf_url, meta_fresh`,
      [
        meta.title, meta.openalex_id, meta.openalex_url, meta.doi, meta.year, meta.venue,
        meta.authors, meta.cited_by, meta.abstract, meta.pdf_url,
        sess.orcid, id
      ]
    );
    if (!upd.rowCount) return res.status(404).json({ error: "Library item not found" });
    res.json({ item: upd.rows[0] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------------------------
   NEW: Notes API
----------------------------*/
app.get("/api/notes", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const { paper_id } = req.query;
  if (!paper_id) return res.status(400).json({ error: "paper_id required" });
  const { rows } = await pool.query(
    `SELECT id, text, created_at FROM notes
     WHERE orcid=$1 AND paper_id=$2
     ORDER BY created_at DESC`,
    [sess.orcid, String(paper_id)]
  );
  res.json(rows);
});

app.post("/api/notes", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  const { paper_id, text } = req.body || {};
  if (!paper_id || !text) return res.status(400).json({ error: "paper_id and text required" });
  const out = await pool.query(
    `INSERT INTO notes (orcid, paper_id, text)
     VALUES ($1, $2, $3)
     RETURNING id, text, created_at`,
    [sess.orcid, String(paper_id), String(text)]
  );
  res.status(201).json(out.rows[0]);
});

app.delete("/api/notes/:id", async (req, res) => {
  const sess = await requireAuth(req, res); if (!sess) return;
  await pool.query(`DELETE FROM notes WHERE orcid=$1 AND id=$2`, [sess.orcid, Number(req.params.id)]);
  res.status(204).end();
});

/* ---------------------------
   Claims/Merges (kept as-is)
----------------------------*/
app.get("/api/claims", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  res.json(await claimsList(sess.orcid));
});

app.post("/api/claims", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  const { author_id } = req.body || {};
  if (!author_id || !/^A\d+$/.test(String(author_id))) {
    return res.status(400).json({ error: "author_id must look like A123..." });
  }
  await claimAdd(sess.orcid, String(author_id));
  res.status(201).json({ ok: true });
});

app.delete("/api/claims/:author_id", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  await claimDel(sess.orcid, String(req.params.author_id));
  res.status(204).end();
});

app.post("/api/claims/merge", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  const { primary_author_id, merged_author_id } = req.body || {};
  if (!/^A\d+$/.test(String(primary_author_id)) || !/^A\d+$/.test(String(merged_author_id))) {
    return res.status(400).json({ error: "author ids must look like A123..." });
  }
  await mergeAdd(sess.orcid, String(primary_author_id), String(merged_author_id));
  res.status(201).json({ ok: true });
});

app.delete("/api/claims/merge", async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return res.status(401).json({ error: "Not signed in" });
  const { primary_author_id, merged_author_id } = req.query || {};
  if (!primary_author_id || !merged_author_id) return res.status(400).json({ error: "both ids required" });
  await mergeDel(sess.orcid, String(primary_author_id), String(merged_author_id));
  res.status(204).end();
});

/* ---------------------------
   SPA fallback
----------------------------*/
app.get("*", (req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    return res.sendFile(path.join(staticRoot, "index.html"));
  }
  next();
});

app.listen(PORT, () => {
  const host = NODE_ENV === "production" ? "https://scienceecosystem.org" : `http://localhost:${PORT}`;
  console.log(`ScienceEcosystem server (Postgres) running at ${host}`);
});
