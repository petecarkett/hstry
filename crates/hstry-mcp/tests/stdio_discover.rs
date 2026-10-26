use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

use serde_json::{Value, json};

#[test]
fn stateless_discover_precedes_tools_without_legacy_handshake() -> anyhow::Result<()> {
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

    // A malformed discovery probe must not kill the stdio connection.
    // Modern MCP requires both protocolVersion and clientCapabilities.
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":"probe-without-meta",
            "method":"server/discover","params":{}})
    )?;
    input.flush()?;
    let mut line = String::new();
    assert!(
        output.read_line(&mut line)? > 0,
        "server exited on invalid probe"
    );
    let invalid: Value = serde_json::from_str(&line)?;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");

    let meta = json!({
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
    });
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":"openai-mcp-discover",
            "method":"server/discover","params":{"_meta":meta}})
    )?;
    input.flush()?;
    line.clear();
    assert!(
        output.read_line(&mut line)? > 0,
        "server rejected valid discovery"
    );
    let discovery: Value = serde_json::from_str(&line)?;
    assert!(discovery.get("error").is_none(), "{discovery}");
    assert_eq!(discovery["result"]["resultType"], "complete");
    assert!(
        discovery["result"]["supportedVersions"]
            .as_array()
            .expect("supported versions")
            .iter()
            .any(|version| version == "2026-07-28"),
        "{discovery}"
    );

    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list",
          "params":{"_meta":meta}})
    )?;
    input.flush()?;
    line.clear();
    assert!(
        output.read_line(&mut line)? > 0,
        "server exited after discovery"
    );
    let listed: Value = serde_json::from_str(&line)?;
    let tools = listed["result"]["tools"]
        .as_array()
        .expect("tools list response");
    assert!(tools.iter().any(|tool| tool["name"] == "search"));
    assert!(tools.iter().any(|tool| tool["name"] == "expand"));

    drop(input);
    assert!(child.wait()?.success());
    Ok(())
}
