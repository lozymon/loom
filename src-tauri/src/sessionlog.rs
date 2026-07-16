//! Durable Session/Task history in SQLite (ADR-0009), plus the durable bus-command **audit** trail
//! (ADR-0012 rule 4). The in-memory TS stores (`src/stores/sessions.ts`, `src/stores/audit.ts`) are
//! the live source of truth; this is their durable, queryable mirror — answering "what did my agents
//! do?" and, for audit, "who drove whom, and from where" after a restart.
//!
//! TS drives every write (no product logic in Rust, like `workspaces.json`): it hands us a row to
//! append/upsert and we run the SQL — we never parse the bus protocol or decide what a row means.
//! Only structured lifecycle/audit rows land here, never PTY bytes, so this stays off the flood path
//! (ADR-0003/0006). The audit trail is why ADR-0012 rule 4 is a hard requirement rather than
//! aspirational: a phone-driven `broadcast` must be attributable after the fact, not just live.

use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The open DB connection, managed as Tauri state behind a mutex (writes are tiny and low-volume —
/// one upsert per agent turn / tool-use, not per byte — so a single guarded connection is ample).
pub struct SessionLog(pub Mutex<Connection>);

/// One agent run (mirrors the TS `Session`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    id: String,
    pane_id: i64,
    agent_id: String,
    cwd: String,
    started_at: i64,
    ended_at: Option<i64>,
    state: String,
}

/// One unit of work (mirrors the TS `Task`). `files` is stored as a JSON array string;
/// `approval` is flattened into two nullable columns.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    id: String,
    session_id: String,
    title: String,
    state: String,
    started_at: i64,
    ended_at: Option<i64>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    approval: Option<Approval>,
}

#[derive(Deserialize)]
struct Approval {
    prompt: String,
    kind: String,
}

/// A search / recent-history hit: a task joined with its session's agent + cwd, for display.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskHit {
    task_id: String,
    session_id: String,
    agent_id: String,
    cwd: String,
    title: String,
    state: String,
    started_at: i64,
    ended_at: Option<i64>,
    files: Vec<String>,
}

/// Open (creating if needed) the history DB at `app_data_dir()/sessions.db` and ensure the schema.
pub fn open(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("sessions.db")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions(
            id TEXT PRIMARY KEY,
            pane_id INTEGER,
            agent_id TEXT,
            cwd TEXT,
            started_at INTEGER,
            ended_at INTEGER,
            state TEXT
         );
         CREATE TABLE IF NOT EXISTS tasks(
            id TEXT PRIMARY KEY,
            session_id TEXT,
            title TEXT,
            state TEXT,
            started_at INTEGER,
            ended_at INTEGER,
            files TEXT,
            approval_prompt TEXT,
            approval_kind TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
         CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at);
         CREATE TABLE IF NOT EXISTS audit(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            op TEXT NOT NULL,
            target TEXT,
            ok INTEGER NOT NULL,
            detail TEXT,
            origin TEXT NOT NULL DEFAULT 'local'
         );
         CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Wall-clock millis since the epoch (used by pruning; the per-row timestamps come from TS).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Prune the history to a bounded window (ADR-0009). The *policy* lives in TS settings
/// (`historyMaxAgeDays` / `historyMaxSessions`); TS calls this once at startup with the configured
/// caps and we just run the SQL. A cap of `<= 0` disables it. Drops out-of-window sessions, then
/// any tasks left orphaned. Low-cost, off the hot path.
#[tauri::command]
pub fn session_log_prune(
    log: tauri::State<SessionLog>,
    max_age_days: i64,
    max_sessions: i64,
) -> Result<(), String> {
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    if max_age_days > 0 {
        let cutoff = now_ms() - max_age_days * 24 * 60 * 60 * 1000;
        conn.execute(
            "DELETE FROM sessions WHERE started_at < ?1",
            params![cutoff],
        )
        .map_err(|e| e.to_string())?;
    }
    if max_sessions > 0 {
        conn.execute(
            "DELETE FROM sessions WHERE id NOT IN \
             (SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?1)",
            params![max_sessions],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "DELETE FROM tasks WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Upsert one Session row (on start / state change / end). Idempotent by `id`.
#[tauri::command]
pub fn session_log_save_session(
    log: tauri::State<SessionLog>,
    session: SessionRow,
) -> Result<(), String> {
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO sessions(id, pane_id, agent_id, cwd, started_at, ended_at, state)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, state = excluded.state",
        params![
            session.id,
            session.pane_id,
            session.agent_id,
            session.cwd,
            session.started_at,
            session.ended_at,
            session.state,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Upsert one Task row (on begin / update / end / approval). Idempotent by `id`.
#[tauri::command]
pub fn session_log_save_task(log: tauri::State<SessionLog>, task: TaskRow) -> Result<(), String> {
    let files = serde_json::to_string(&task.files).unwrap_or_else(|_| "[]".to_string());
    let (prompt, kind) = match &task.approval {
        Some(a) => (Some(a.prompt.clone()), Some(a.kind.clone())),
        None => (None, None),
    };
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tasks(id, session_id, title, state, started_at, ended_at, files, approval_prompt, approval_kind)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, state = excluded.state, ended_at = excluded.ended_at,
            files = excluded.files, approval_prompt = excluded.approval_prompt,
            approval_kind = excluded.approval_kind",
        params![
            task.id,
            task.session_id,
            task.title,
            task.state,
            task.started_at,
            task.ended_at,
            files,
            prompt,
            kind,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The shared SELECT for hits — a task joined with its session, newest first.
const HIT_SELECT: &str = "SELECT t.id, t.session_id, s.agent_id, s.cwd, t.title, t.state, \
     t.started_at, t.ended_at, t.files \
     FROM tasks t JOIN sessions s ON s.id = t.session_id";

fn map_hit(row: &rusqlite::Row) -> rusqlite::Result<TaskHit> {
    let files_json: String = row.get(8)?;
    Ok(TaskHit {
        task_id: row.get(0)?,
        session_id: row.get(1)?,
        agent_id: row.get(2)?,
        cwd: row.get(3)?,
        title: row.get(4)?,
        state: row.get(5)?,
        started_at: row.get(6)?,
        ended_at: row.get(7)?,
        files: serde_json::from_str(&files_json).unwrap_or_default(),
    })
}

/// Cross-session search over task titles and approval prompts (substring, case-insensitive).
#[tauri::command]
pub fn session_log_search(
    log: tauri::State<SessionLog>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<TaskHit>, String> {
    let lim = limit.unwrap_or(100).min(1000);
    let like = format!("%{}%", query.trim());
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    let sql = format!(
        "{HIT_SELECT} WHERE t.title LIKE ?1 OR t.approval_prompt LIKE ?1 \
         ORDER BY t.started_at DESC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let hits = stmt
        .query_map(params![like, lim], map_hit)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(hits)
}

/// Recent task history across all sessions (newest first) — the "what did my agents do" view.
#[tauri::command]
pub fn session_log_recent(
    log: tauri::State<SessionLog>,
    limit: Option<u32>,
) -> Result<Vec<TaskHit>, String> {
    let lim = limit.unwrap_or(100).min(1000);
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("{HIT_SELECT} ORDER BY t.started_at DESC LIMIT ?1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let hits = stmt
        .query_map(params![lim], map_hit)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(hits)
}

// ---- Audit trail (ADR-0012 rule 4) --------------------------------------------------------------
// The durable half of the bus-command timeline. The live view stays a bounded in-memory ring
// (stores/audit.ts); this is the after-the-fact record. Append-only from TS; one row per relayed
// command, so it is low-volume like the Session/Task writes and stays off the flood path.

/// One relayed bus command, as TS records it. No `id`: the DB autoincrements its own, since the
/// in-memory ring's ids are a per-run sequence and would collide across restarts.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    ts: i64,
    op: String,
    target: Option<String>,
    ok: bool,
    detail: Option<String>,
    /// `local` | `device:<name>` (ADR-0012 rule 4). Defaults to `local` for callers not yet
    /// origin-aware (every caller today; the remote envelope arrives with P2).
    #[serde(default = "default_origin")]
    origin: String,
}

fn default_origin() -> String {
    "local".to_string()
}

/// One audit row for display/hydration (mirrors the TS `AuditEntry`, minus the ephemeral list id).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditHit {
    ts: i64,
    op: String,
    target: Option<String>,
    ok: bool,
    detail: Option<String>,
    origin: String,
}

/// Append one relayed command to the durable audit trail. Best-effort from TS's view.
#[tauri::command]
pub fn audit_log_save(log: tauri::State<SessionLog>, entry: AuditRow) -> Result<(), String> {
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO audit(ts, op, target, ok, detail, origin) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            entry.ts,
            entry.op,
            entry.target,
            entry.ok as i64,
            entry.detail,
            entry.origin,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The most recent audit rows, oldest-first (so TS can seed its ring in timeline order). `limit`
/// caps the load; the DB may hold more (trimmed by `audit_log_prune`).
#[tauri::command]
pub fn audit_log_recent(
    log: tauri::State<SessionLog>,
    limit: Option<u32>,
) -> Result<Vec<AuditHit>, String> {
    let lim = limit.unwrap_or(500).min(5000);
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    // Take the newest `lim` by id, then hand them back ascending so the ring ends newest-last.
    let mut stmt = conn
        .prepare(
            "SELECT ts, op, target, ok, detail, origin FROM \
             (SELECT * FROM audit ORDER BY id DESC LIMIT ?1) ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let hits = stmt
        .query_map(params![lim], |row| {
            Ok(AuditHit {
                ts: row.get(0)?,
                op: row.get(1)?,
                target: row.get(2)?,
                ok: row.get::<_, i64>(3)? != 0,
                detail: row.get(4)?,
                origin: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(hits)
}

/// Trim the audit trail to a bounded window — the durable analogue of the in-memory ring's cap.
/// Drops rows older than `max_age_days` (if > 0) and keeps at most `max_rows` (if > 0). Called at
/// startup, like `session_log_prune`.
#[tauri::command]
pub fn audit_log_prune(
    log: tauri::State<SessionLog>,
    max_age_days: i64,
    max_rows: i64,
) -> Result<(), String> {
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    if max_age_days > 0 {
        let cutoff = now_ms() - max_age_days * 24 * 60 * 60 * 1000;
        conn.execute("DELETE FROM audit WHERE ts < ?1", params![cutoff])
            .map_err(|e| e.to_string())?;
    }
    if max_rows > 0 {
        conn.execute(
            "DELETE FROM audit WHERE id NOT IN \
             (SELECT id FROM audit ORDER BY id DESC LIMIT ?1)",
            params![max_rows],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Wipe the whole audit trail (the UI "clear timeline" affordance — clears the ring *and* the
/// durable record, so a restart doesn't resurrect what the operator cleared).
#[tauri::command]
pub fn audit_log_clear(log: tauri::State<SessionLog>) -> Result<(), String> {
    let conn = log.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM audit", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
