use anyhow::Result;
use hstry_core::db::{Database, SearchOptions};
use hstry_core::ingest::ingest_batch;
use hstry_core::live::{LiveCapture, ingest_live_capture};
use hstry_core::parsed::ParsedConversation;
use hstry_core::read::ReadOptions;
use uuid::Uuid;

#[tokio::test]
async fn live_turns_search_and_merge_without_duplicates() -> Result<()> {
    let path = std::env::temp_dir().join(format!("hstry-live-{}.db", Uuid::new_v4()));
    let db = Database::open(&path).await?;
    let source = "chatgpt-web-acct1234";
    let project = "g-p-6818bc97551c8191865a07d09f7b3678";
    let conversation = "6addfdd2-81e0-83eb-b37c-97d7b316d6b8";
    let message = "f9085be9-bc56-4ba8-826b-a6e3d4b4b883";
    let url = format!("https://chatgpt.com/g/{project}-1hood/c/{conversation}");
    let mut live = LiveCapture {
        conversation_id: conversation.into(),
        message_id: message.into(),
        project_id: Some(project.into()),
        project_name: None,
        account_id: Some("acct1234".into()),
        url: url.clone(),
        title: "Chat test".into(),
        role: "user".into(),
        content: "distinctive live capture needle alpha".into(),
        observed_at: chrono::Utc::now().timestamp_millis(),
    };
    let first = ingest_live_capture(&db, source, &live).await?;
    assert_eq!(first.status, "created");
    assert_eq!(
        ingest_live_capture(&db, source, &live).await?.status,
        "unchanged"
    );
    let id = db.get_conversation_id(source, conversation).await?.unwrap();
    let live_page = db.read_page(id, ReadOptions::default()).await?;
    assert_eq!(live_page.completeness, "unknown");
    assert_eq!(live_page.unverified_live_messages, 1);
    assert_eq!(
        live_page.latest_live_observed_at,
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(live.observed_at)
            .map(|time| time.to_rfc3339())
    );
    let stored = db
        .get_conversation_by_reference(Some(source), Some(conversation), None, None, None)
        .await?
        .unwrap();
    assert_eq!(stored.workspace.as_deref(), Some(project));
    assert_eq!(stored.metadata["projectId"], project);
    assert_eq!(stored.metadata["accountId"], "acct1234");
    assert_eq!(stored.metadata["url"], url);
    assert_eq!(stored.metadata["captureState"], "provisional");
    assert!(stored.metadata.get("projectName").is_none());
    // The first browser capture may predate project-name discovery. Replaying
    // the same message must enrich metadata without adding a second message.
    live.project_name = Some("1hood".into());
    assert_eq!(
        ingest_live_capture(&db, source, &live).await?.status,
        "unchanged"
    );
    let enriched = db
        .get_conversation_by_reference(Some(source), Some(conversation), None, None, None)
        .await?
        .unwrap();
    assert_eq!(enriched.metadata["projectName"], "1hood");
    let found = db.search("distinctive", SearchOptions::default()).await?;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].source_id, source);
    assert_eq!(found[0].workspace.as_deref(), Some(project));
    assert!(db.get_messages(id).await?[0].idx >= 1_000_000_000);
    live.content = "distinctive live capture needle beta".into();
    assert_eq!(
        ingest_live_capture(&db, source, &live).await?.status,
        "updated"
    );
    assert_eq!(db.get_messages(id).await?.len(), 1);

    let canonical: ParsedConversation = serde_json::from_value(serde_json::json!({
        "externalId": conversation,
        "title": "1hood canonical title",
        "createdAt": 1700000000000_i64,
        "updatedAt": live.observed_at,
        "provider": "openai",
        "workspace": project,
        "metadata": {
            "url": url, "projectId": project, "projectName": "1hood",
            "accountId": "acct1234"
        },
        "messages": [{
            "role": "user", "content": "distinctive canonical needle final",
            "createdAt": 1700000000000_i64,
            "metadata": { "messageId": message }
        }]
    }))?;
    let imported = ingest_batch(&db, source, vec![canonical.clone()]).await?;
    db.rebuild_conversation_summaries(&imported.affected_conversation_ids)
        .await?;
    let stored = db
        .get_conversation_by_reference(Some(source), Some(conversation), None, None, None)
        .await?
        .unwrap();
    assert_eq!(stored.id, id);
    assert_eq!(stored.created_at.timestamp(), 1700000000);
    assert_eq!(stored.title.as_deref(), Some("1hood canonical title"));
    assert_eq!(stored.metadata.get("captureState"), None);
    let messages = db.get_messages(id).await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].idx, 0);
    assert_eq!(messages[0].client_id.as_deref(), Some(message));
    assert_eq!(messages[0].content, "distinctive canonical needle final");
    let canonical_page = db.read_page(id, ReadOptions::default()).await?;
    assert_eq!(canonical_page.unverified_live_messages, 0);
    assert_eq!(canonical_page.latest_live_observed_at, None);
    assert_eq!(canonical_page.completeness, "unknown");
    let hits = db.search("distinctive", SearchOptions::default()).await?;
    assert_eq!(hits.len(), 1, "no extra provisional search result");
    // A partial canonical detail can know the exact project ID but not its
    // name. It must not wipe the name learned from authoritative discovery.
    let mut without_name = canonical.clone();
    without_name.metadata.as_mut().unwrap()["projectName"] = serde_json::Value::Null;
    let incomplete = ingest_batch(&db, source, vec![without_name]).await?;
    db.rebuild_conversation_summaries(&incomplete.affected_conversation_ids)
        .await?;
    let after_incomplete = db
        .get_conversation_by_reference(Some(source), Some(conversation), None, None, None)
        .await?
        .unwrap();
    assert_eq!(after_incomplete.metadata["projectName"], "1hood");
    let repeat = ingest_batch(&db, source, vec![canonical.clone()]).await?;
    db.rebuild_conversation_summaries(&repeat.affected_conversation_ids)
        .await?;
    assert_eq!(db.get_messages(id).await?.len(), 1);

    // A real project move must NOT retain a stale name from the old project.
    let destination = "g-p-11111111111111111111111111111111";
    let mut moved = canonical.clone();
    moved.workspace = Some(destination.to_string());
    moved.metadata.as_mut().unwrap()["projectId"] = serde_json::json!(destination);
    moved.metadata.as_mut().unwrap()["projectName"] = serde_json::Value::Null;
    moved.metadata.as_mut().unwrap()["url"] = serde_json::json!(format!(
        "https://chatgpt.com/g/{destination}/c/{conversation}"
    ));
    let result = ingest_batch(&db, source, vec![moved.clone()]).await?;
    db.rebuild_conversation_summaries(&result.affected_conversation_ids)
        .await?;
    let after_move = db
        .get_conversation_by_reference(Some(source), Some(conversation), None, None, None)
        .await?
        .unwrap();
    assert_eq!(after_move.workspace.as_deref(), Some(destination));
    assert!(after_move.metadata["projectName"].is_null());

    // An explicit move to personal chats must clear the previous project.
    moved.workspace = None;
    moved.metadata.as_mut().unwrap()["projectId"] = serde_json::Value::Null;
    moved.metadata.as_mut().unwrap()["projectName"] = serde_json::Value::Null;
    moved.metadata.as_mut().unwrap()["url"] =
        serde_json::json!(format!("https://chatgpt.com/c/{conversation}"));
    let result = ingest_batch(&db, source, vec![moved]).await?;
    db.rebuild_conversation_summaries(&result.affected_conversation_ids)
        .await?;
    let after_clear = db
        .get_conversation_by_reference(Some(source), Some(conversation), None, None, None)
        .await?
        .unwrap();
    assert!(after_clear.workspace.is_none());
    assert!(after_clear.metadata["projectName"].is_null());
    db.close().await;
    let _ = std::fs::remove_file(&path);
    Ok(())
}
