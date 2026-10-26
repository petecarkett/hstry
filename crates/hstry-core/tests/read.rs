use hstry_core::{
    Database,
    models::{Conversation, Message, Source},
    read::ReadOptions,
};
use serde_json::json;

async fn fixture() -> anyhow::Result<(tempfile::TempDir, Database, uuid::Uuid)> {
    let dir = tempfile::tempdir()?;
    let db = Database::open(&dir.path().join("read.db")).await?;
    db.upsert_source(&Source {
        id: "fixture".into(),
        adapter: "pi".into(),
        path: None,
        last_sync_at: None,
        config: json!({}),
    })
    .await?;
    let id = uuid::Uuid::new_v4();
    let conv: Conversation = serde_json::from_value(
        json!({"id":id,"source_id":"fixture","created_at":"2026-01-01T00:00:00Z","metadata":{}}),
    )?;
    db.upsert_conversation(&conv).await?;
    for idx in 0..3 {
        let msg: Message = serde_json::from_value(
            json!({"id":uuid::Uuid::new_v4(),"conversation_id":id,"idx":idx,"role":"tool","content":if idx==1 {"needle evidence".into()} else {"\"界\\\n".repeat(5000)},"parts_json":[],"metadata":{}}),
        )?;
        db.insert_message(&msg).await?;
    }
    Ok((dir, db, id))
}

#[tokio::test]
async fn bounded_context_keeps_anchor_before_large_neighbors() -> anyhow::Result<()> {
    let (_dir, db, id) = fixture().await?;
    let page = db
        .read_page(
            id,
            ReadOptions {
                message_idx: Some(1),
                before: 1,
                after: 1,
                max_chars: 1500,
                ..Default::default()
            },
        )
        .await?;
    assert_eq!(
        (
            &page.records[0].field,
            page.records[0].message_idx,
            &page.records[0].text
        ),
        (&"content".to_owned(), 1, &"needle evidence".to_owned())
    );
    assert!(page.to_wire()?.chars().count() + 1 <= 1500);
    assert!(page.truncated);
    Ok(())
}

#[tokio::test]
async fn field_continuations_reconstruct_unicode_without_gaps() -> anyhow::Result<()> {
    let (_dir, db, id) = fixture().await?;
    let mut offset = 0;
    let mut text = String::new();
    loop {
        let page = db
            .read_page(
                id,
                ReadOptions {
                    message_idx: Some(0),
                    field: Some("content".into()),
                    offset_chars: offset,
                    max_chars: 1100,
                    ..Default::default()
                },
            )
            .await?;
        assert!(page.to_wire()?.chars().count() + 1 <= 1100);
        text.push_str(&page.records[0].text);
        match page.records[0].next_offset_chars {
            Some(next) => {
                assert!(next > offset);
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(text, "\"界\\\n".repeat(5000));
    Ok(())
}

#[tokio::test]
async fn long_visible_text_parts_are_readable_without_exposing_thinking() -> anyhow::Result<()> {
    let (_dir, db, id) = fixture().await?;
    let long_text = "界abc\\n".repeat(3000);
    let visible: Message = serde_json::from_value(json!({
        "id":uuid::Uuid::new_v4(),"conversation_id":id,"idx":3,
        "role":"assistant","content":long_text,
        "parts_json":[{"type":"text","text":long_text}],"metadata":{}
    }))?;
    db.insert_message(&visible).await?;
    let hidden: Message = serde_json::from_value(json!({
        "id":uuid::Uuid::new_v4(),"conversation_id":id,"idx":4,
        "role":"assistant","content":"PRIVATE_CHAIN",
        "parts_json":[{"type":"thinking","text":"PRIVATE_CHAIN"}],"metadata":{}
    }))?;
    db.insert_message(&hidden).await?;

    let listed = db
        .read_page(
            id,
            ReadOptions {
                message_idx: Some(3),
                max_chars: 1600,
                ..Default::default()
            },
        )
        .await?;
    assert_eq!(
        listed.total, 2,
        "projection must advertise the original text part"
    );
    assert_eq!(listed.records[0].field, "content");
    assert!(listed.to_wire()?.chars().count() + 1 <= 1600);

    let mut offset = 0;
    let mut reconstructed = String::new();
    loop {
        let page = db
            .read_page(
                id,
                ReadOptions {
                    message_idx: Some(3),
                    field: Some("parts/0/text".into()),
                    offset_chars: offset,
                    max_chars: 1100,
                    ..Default::default()
                },
            )
            .await?;
        assert!(page.to_wire()?.chars().count() + 1 <= 1100);
        let record = &page.records[0];
        assert_eq!(record.total_chars, long_text.chars().count());
        reconstructed.push_str(&record.text);
        if let Some(next) = record.next_offset_chars {
            assert!(next > offset);
            offset = next;
        } else {
            break;
        }
    }
    assert_eq!(reconstructed, long_text);

    assert!(
        db.read_page(
            id,
            ReadOptions {
                message_idx: Some(4),
                field: Some("parts/0/text".into()),
                ..Default::default()
            }
        )
        .await
        .is_err(),
        "hidden thinking must never be accessible as text"
    );
    assert!(
        db.read_page(
            id,
            ReadOptions {
                message_idx: Some(4),
                field: Some("content".into()),
                ..Default::default()
            },
        )
        .await
        .is_err(),
        "hidden thinking must not leak through the content projection"
    );
    assert!(
        db.read_page(
            id,
            ReadOptions {
                message_id: Some(hidden.id),
                field: Some("content".into()),
                ..Default::default()
            },
        )
        .await
        .is_err(),
        "hidden thinking must not leak through a direct ID lookup"
    );
    let default_page = db
        .read_page(
            id,
            ReadOptions {
                max_chars: 3000,
                ..Default::default()
            },
        )
        .await?;
    assert!(
        default_page
            .records
            .iter()
            .all(|record| record.message_idx != 4),
        "hidden thinking must be absent from normal read pagination"
    );
    assert!(
        db.read_page(
            id,
            ReadOptions {
                message_idx: Some(3),
                field: Some("parts/0/secret".into()),
                ..Default::default()
            }
        )
        .await
        .is_err(),
        "arbitrary JSON paths must remain rejected"
    );
    Ok(())
}

#[tokio::test]
async fn interaction_expansion_follows_only_direct_ids_and_rejects_stale_pages()
-> anyhow::Result<()> {
    let (_dir, db, id) = fixture().await?;
    for (idx, parts) in [
        (
            3,
            json!([{"type":"tool_call","toolCallId":"owned","input":{"command":"fixture"}}]),
        ),
        (
            4,
            json!([{"type":"tool_result","toolCallId":"owned","output":"result"},{"type":"tool_call","toolCallId":"other","input":{}}]),
        ),
        (
            5,
            json!([{"type":"tool_result","toolCallId":"other","output":"not directly owned"}]),
        ),
    ] {
        let m: Message = serde_json::from_value(
            json!({"id":uuid::Uuid::new_v4(),"conversation_id":id,"idx":idx,"role":"assistant","content":"fixture","parts_json":parts,"metadata":{}}),
        )?;
        db.insert_message(&m).await?;
    }
    let page = db
        .read_page(
            id,
            ReadOptions {
                message_idx: Some(3),
                expand_interactions: true,
                max_chars: 12000,
                ..Default::default()
            },
        )
        .await?;
    assert_eq!(
        page.records
            .iter()
            .map(|r| (r.message_idx, r.field.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (3, "content"),
            (3, "parts/0/input"),
            (4, "content"),
            (4, "parts/0/output"),
            (4, "parts/1/input")
        ]
    );
    assert!(
        db.read_page(
            id,
            ReadOptions {
                version: Some(-1),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    Ok(())
}
