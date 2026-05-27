use anyhow::{bail, Context};
use orb_common::AgentBackend;
use std::{fs, path::Path};

#[derive(Debug, Clone)]
pub struct AgentBackends {
    items: Vec<AgentBackend>,
}

impl Default for AgentBackends {
    fn default() -> Self {
        Self {
            items: vec![
                AgentBackend {
                    id: "codex".into(),
                    name: "Codex".into(),
                    command: "codex".into(),
                    args: vec!["--dangerously-bypass-approvals-and-sandbox".into()],
                },
                AgentBackend {
                    id: "claude".into(),
                    name: "Claude Code".into(),
                    command: "claude".into(),
                    args: vec!["--dangerously-skip-permissions".into()],
                },
                AgentBackend {
                    id: "opencode".into(),
                    name: "OpenCode".into(),
                    command: "opencode".into(),
                    args: vec![],
                },
                AgentBackend {
                    id: "pi".into(),
                    name: "pi".into(),
                    command: "pi".into(),
                    args: vec![],
                },
            ],
        }
    }
}

impl AgentBackends {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let input = fs::read_to_string(path)
            .with_context(|| format!("read backend config {}", path.display()))?;
        let items = parse_backends_yaml(&input)
            .with_context(|| format!("parse backend config {}", path.display()))?;
        if items.is_empty() {
            bail!("backend config must define at least one backend");
        }
        Ok(Self { items })
    }

    pub fn list(&self) -> Vec<AgentBackend> {
        self.items.clone()
    }

    pub fn get(&self, id: &str) -> Option<&AgentBackend> {
        self.items.iter().find(|backend| backend.id == id)
    }
}

fn parse_backends_yaml(input: &str) -> anyhow::Result<Vec<AgentBackend>> {
    let mut result = Vec::new();
    let mut current: Option<AgentBackend> = None;
    let mut in_args = false;

    for raw in input.lines() {
        let without_comment = raw.split_once('#').map(|(left, _)| left).unwrap_or(raw);
        if without_comment.trim().is_empty() {
            continue;
        }
        let indent = without_comment.len() - without_comment.trim_start().len();
        let line = without_comment.trim();

        if indent == 0 {
            in_args = false;
            continue;
        }

        if indent == 2 && line.starts_with("- ") {
            if let Some(backend) = current.take() {
                result.push(validate_backend(backend)?);
            }
            current = Some(AgentBackend {
                id: String::new(),
                name: String::new(),
                command: String::new(),
                args: Vec::new(),
            });
            in_args = false;
            let rest = line.trim_start_matches("- ").trim();
            if !rest.is_empty() {
                apply_field(current.as_mut().unwrap(), rest, &mut in_args)?;
            }
            continue;
        }

        if indent == 2 && line.ends_with(':') {
            if let Some(backend) = current.take() {
                result.push(validate_backend(backend)?);
            }
            let id = line.trim_end_matches(':').trim().to_string();
            current = Some(AgentBackend {
                id: parse_scalar(&id),
                name: String::new(),
                command: String::new(),
                args: Vec::new(),
            });
            in_args = false;
            continue;
        }

        if indent == 4 {
            let backend = current
                .as_mut()
                .context("backend field found before backend item")?;
            apply_field(backend, line, &mut in_args)?;
            continue;
        }

        if indent >= 6 && in_args && line.starts_with("- ") {
            let backend = current
                .as_mut()
                .context("backend args found before backend item")?;
            backend
                .args
                .push(parse_scalar(line.trim_start_matches("- ").trim()));
        }
    }

    if let Some(backend) = current.take() {
        result.push(validate_backend(backend)?);
    }
    Ok(result)
}

fn apply_field(backend: &mut AgentBackend, line: &str, in_args: &mut bool) -> anyhow::Result<()> {
    let (key, value) = line
        .split_once(':')
        .with_context(|| format!("expected key: value, got {line:?}"))?;
    let key = key.trim();
    let value = value.trim();
    *in_args = false;
    match key {
        "id" => backend.id = parse_scalar(value),
        "name" => backend.name = parse_scalar(value),
        "command" | "executable" => backend.command = parse_scalar(value),
        "args" => {
            if value.is_empty() {
                *in_args = true;
            } else {
                backend.args = parse_inline_list(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_backend(mut backend: AgentBackend) -> anyhow::Result<AgentBackend> {
    backend.id = backend.id.trim().to_string();
    backend.command = backend.command.trim().to_string();
    if backend.name.trim().is_empty() {
        backend.name = backend.id.clone();
    }
    if backend.id.is_empty() {
        bail!("backend id is required");
    }
    if backend.command.is_empty() {
        bail!("backend {} command is required", backend.id);
    }
    Ok(backend)
}

fn parse_inline_list(value: &str) -> anyhow::Result<Vec<String>> {
    let value = value.trim();
    if !(value.starts_with('[') && value.ends_with(']')) {
        return Ok(vec![parse_scalar(value)]);
    }
    let inner = &value[1..value.len() - 1];
    if inner.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(inner
        .split(',')
        .map(|item| parse_scalar(item.trim()))
        .collect())
}

fn parse_scalar(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::parse_backends_yaml;

    #[test]
    fn parses_list_style_backends() {
        let backends = parse_backends_yaml(
            r#"
backends:
  - id: aider
    name: Aider
    command: aider
    args:
      - --yes-always
"#,
        )
        .unwrap();
        assert_eq!(backends[0].id, "aider");
        assert_eq!(backends[0].args, vec!["--yes-always"]);
    }

    #[test]
    fn parses_map_style_backends() {
        let backends = parse_backends_yaml(
            r#"
backends:
  local:
    command: /tmp/agent
    args: ["--flag", value]
"#,
        )
        .unwrap();
        assert_eq!(backends[0].id, "local");
        assert_eq!(backends[0].command, "/tmp/agent");
        assert_eq!(backends[0].args, vec!["--flag", "value"]);
    }
}
