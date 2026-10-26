use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

use serde_json::{Value, json};

#[test]
fn stdio_keeps_serving_tools_after_initialization() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let config = temp.path().join("config.toml");
    let database = temp.path().join("messages.db");
    std::fs::write(
        &config,
        format!("database = {}\n", serde_json::to_string(&database)?),
    )?;

    let mut child = Command::new(env!("CARGO_BIN_EXE_hstry-mcp"))
        .arg("--config")
        .arg(config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let mut input = child.stdin.take().expect("stdin available");
    let mut output = BufReader::new(child.stdout.take().expect("stdout available"));

    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-03-26","capabilities":{},
                "clientInfo":{"name":"hstry-lifecycle-test","version":"1.0"}}})
    )?;
    input.flush()?;
    let mut line = String::new();
    assert!(
        output.read_line(&mut line)? > 0,
        "missing initialize response"
    );
    let initialized: Value = serde_json::from_str(&line)?;
    assert!(initialized.get("result").is_some(), "{initialized}");

    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )?;
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
    )?;
    input.flush()?;
    line.clear();
    assert!(
        output.read_line(&mut line)? > 0,
        "server exited after initialize"
    );
    let listed: Value = serde_json::from_str(&line)?;
    let tools = listed["result"]["tools"]
        .as_array()
        .expect("tools list response");
    assert!(tools.iter().any(|tool| tool["name"] == "search"));
    assert!(tools.iter().any(|tool| tool["name"] == "expand"));

    drop(input);
    assert!(
        child.wait()?.success(),
        "MCP server should exit cleanly on EOF"
    );
    Ok(())
}
