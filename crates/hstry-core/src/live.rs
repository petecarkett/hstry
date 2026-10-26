//! Incremental browser observations in HSTRY's existing conversation and message tables.
//! High indices identify unverified turns until canonical history assigns their order.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::Database;
use crate::error::{Error, Result};

const LIVE_BASE: i64 = 1_000_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveCapture {
    pub conversation_id: String,
    pub message_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub account_id: Option<String>,
    pub url: String,
    pub title: String,
    pub role: String,
    pub content: String,
    pub observed_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveIngestOutcome {
    pub status: &'static str,
    pub conversation_id: String,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct LiveSource {
    pub source: String,
    pub account_id: Option<String>,
    pub project_name: Option<String>,
}

/// Resolve ambiguous browser account scopes from existing canonical archive
/// ownership, not from a guessed currently selected account.
pub async fn resolve_live_source(
    db: &Database,
    capture: &LiveCapture,
) -> Result<Option<LiveSource>> {
    let exact = sqlx::query(
        "SELECT source_id, MAX(json_extract(metadata,'$.accountId')) AS account_id, MAX(json_extract(metadata,'$.projectName')) AS project_name FROM conversations WHERE source_id LIKE 'chatgpt-web%' AND external_id=? GROUP BY source_id"
    ).bind(&capture.conversation_id).fetch_all(db.read_pool()).await?;
    let records = if exact.is_empty() {
        if let Some(project) = &capture.project_id {
            sqlx::query(
                "SELECT source_id, MAX(json_extract(metadata,'$.accountId')) AS account_id, MAX(json_extract(metadata,'$.projectName')) AS project_name FROM conversations WHERE source_id LIKE 'chatgpt-web%' AND workspace=? GROUP BY source_id"
            ).bind(project).fetch_all(db.read_pool()).await?
        } else {
            sqlx::query(
                "SELECT source_id, MAX(json_extract(metadata,'$.accountId')) AS account_id, NULL AS project_name FROM conversations WHERE source_id LIKE 'chatgpt-web%' AND workspace IS NULL GROUP BY source_id"
            ).fetch_all(db.read_pool()).await?
        }
    } else {
        exact
    };
    if records.len() != 1 {
        return Ok(None);
    }
    let row = &records[0];
    Ok(Some(LiveSource {
        source: row.get("source_id"),
        account_id: row.get("account_id"),
        project_name: row.get("project_name"),
    }))
}

pub async fn ingest_live_capture(
    db: &Database,
    source_id: &str,
    capture: &LiveCapture,
) -> Result<LiveIngestOutcome> {
    let conversation = Uuid::parse_str(&capture.conversation_id)
        .map_err(|_| Error::Other("Invalid conversation ID".into()))?;
    let message = Uuid::parse_str(&capture.message_id)
        .map_err(|_| Error::Other("Invalid message ID".into()))?;
    let project = capture.project_id.as_deref();
    let path = capture
        .url
        .strip_prefix("https://chatgpt.com/")
        .ok_or_else(|| Error::Other("Invalid ChatGPT URL".into()))?;
    let segments: Vec<&str> = path.split('/').collect();
    let valid_route = match segments.as_slice() {
        ["c", id] => project.is_none() && *id == conversation.to_string(),
        ["g", slug, "c", id] => project.is_some_and(|project_id| {
            project_id.len() == 36
                && project_id.starts_with("g-p-")
                && project_id.as_bytes()[4..].iter().all(u8::is_ascii_hexdigit)
                && (*slug == project_id || slug.starts_with(&format!("{project_id}-")))
                && *id == conversation.to_string()
        }),
        _ => false,
    };
    if !valid_route
        || !["user", "assistant"].contains(&capture.role.as_str())
        || capture.content.trim().is_empty()
        || capture.content.chars().count() > 500_000
        || capture.title.chars().count() > 300
        || capture
            .project_name
            .as_ref()
            .is_some_and(|name| name.chars().count() > 300)
        || capture.account_id.as_ref().is_some_and(|id| id.len() > 150)
        || capture.observed_at <= 0
        || capture.observed_at > Utc::now().timestamp_millis() + 300_000
        || !source_id.starts_with("chatgpt-web")
    {
        return Err(Error::Other("Invalid browser capture".into()));
    }

    let _writer = db.lock_ingest_writer().await;
    let mut tx = db.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO sources (id, adapter, path, config) VALUES (?, 'chatgpt-web', NULL, '{}')")
        .bind(source_id).execute(&mut *tx).await?;
    let existing: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT id,workspace FROM conversations WHERE source_id=? AND external_id=?",
    )
    .bind(source_id)
    .bind(&capture.conversation_id)
    .fetch_optional(&mut *tx)
    .await?;
    let hstry_id = if let Some((id, workspace)) = existing {
        if project.is_some_and(|p| workspace.as_ref().is_some_and(|known| known != p)) {
            return Err(Error::Other("Project ownership conflict".into()));
        }
        // Backfill verified project names from Chrome discovery without changing
        // existing names, account ownership, timestamps, or message contents.
        if let (Some(project_id), Some(name)) = (
            project,
            capture
                .project_name
                .as_deref()
                .filter(|v| !v.trim().is_empty()),
        ) {
            sqlx::query("UPDATE conversations SET metadata=json_set(COALESCE(metadata,'{}'),'$.projectName',?), version=version+1 WHERE source_id=? AND workspace=? AND COALESCE(json_extract(metadata,'$.projectName'),'')=''")
                .bind(name).bind(source_id).bind(project_id)
                .execute(&mut *tx).await?;
        }
        id
    } else {
        let id = Uuid::new_v4();
        let mut metadata = serde_json::json!({
            "url": capture.url, "captureState": "provisional"
        });
        if let Some(project_id) = project {
            metadata["projectId"] = serde_json::json!(project_id);
            if let Some(name) = &capture.project_name {
                metadata["projectName"] = serde_json::json!(name);
            }
        }
        if let Some(account) = &capture.account_id {
            metadata["accountId"] = serde_json::json!(account);
        }
        sqlx::query("INSERT INTO conversations (id,source_id,external_id,readable_id,title,created_at,updated_at,model,provider,workspace,metadata,version,message_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0)")
            .bind(id.to_string()).bind(source_id).bind(&capture.conversation_id)
            .bind(crate::readable_id::base_for(id))
            .bind(&capture.title).bind(capture.observed_at / 1000)
            .bind(capture.observed_at / 1000).bind(None::<String>)
            .bind("openai").bind(project).bind(metadata.to_string())
            .execute(&mut *tx).await?;
        id.to_string()
    };
    let prev = sqlx::query(
        "SELECT id,idx,content,metadata FROM messages WHERE conversation_id=? AND client_id=? ORDER BY idx LIMIT 1"
    ).bind(&hstry_id).bind(message.to_string()).fetch_optional(&mut *tx).await?;
    let status = if let Some(row) = prev {
        let idx: i64 = row.get("idx");
        let id: String = row.get("id");
        let content: String = row.get("content");
        if content == capture.content {
            "unchanged"
        } else {
            // Update the SAME message ID in place, including an existing canonical
            // row, so active editing cannot create a duplicate search result.
            sqlx::query("UPDATE messages SET content=?,metadata=? WHERE id=?")
                .bind(&capture.content)
                .bind(
                    serde_json::json!({"liveProvisional":true,"observedAt":capture.observed_at})
                        .to_string(),
                )
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            if idx < LIVE_BASE {
                "updated-canonical"
            } else {
                "updated"
            }
        }
    } else {
        let next: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(idx),?) + 1 FROM messages WHERE conversation_id=? AND idx>=?",
        )
        .bind(LIVE_BASE - 1)
        .bind(&hstry_id)
        .bind(LIVE_BASE)
        .fetch_one(&mut *tx)
        .await?;
        if next > i64::from(i32::MAX) {
            return Err(Error::Other("Live message index exhausted".into()));
        }
        sqlx::query("INSERT INTO messages (id,conversation_id,idx,role,content,parts_json,created_at,metadata,client_id) VALUES (?,?,?,?,?,'[]',?,?,?)")
            .bind(Uuid::new_v4().to_string()).bind(&hstry_id).bind(next)
            .bind(&capture.role).bind(&capture.content)
            .bind(capture.observed_at / 1000)
            .bind(serde_json::json!({"liveProvisional":true,"observedAt":capture.observed_at}).to_string())
            .bind(message.to_string()).execute(&mut *tx).await?;
        "created"
    };
    tx.commit().await?;
    if status != "unchanged" {
        db.rebuild_conversation_summaries(&[conversation_from_hstry_id(&hstry_id)?])
            .await?;
    }
    Ok(LiveIngestOutcome {
        status,
        conversation_id: capture.conversation_id.clone(),
        source: source_id.to_string(),
    })
}

fn conversation_from_hstry_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| Error::Other("Invalid stored conversation ID".into()))
}
