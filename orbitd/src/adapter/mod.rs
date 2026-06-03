use anyhow::bail;
use orb_common::AgentBackend;

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
    pub fn from_items(items: Vec<AgentBackend>) -> anyhow::Result<Self> {
        if items.is_empty() {
            bail!("config `backends` must define at least one backend");
        }
        let mut normalized = Vec::with_capacity(items.len());
        for backend in items {
            normalized.push(validate_backend(backend)?);
        }
        Ok(Self { items: normalized })
    }

    pub fn list(&self) -> Vec<AgentBackend> {
        self.items.clone()
    }

    pub fn get(&self, id: &str) -> Option<&AgentBackend> {
        self.items.iter().find(|backend| backend.id == id)
    }
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

#[cfg(test)]
mod tests {
    use super::AgentBackends;
    use orb_common::AgentBackend;

    #[test]
    fn from_items_validates_and_fills_name() {
        let backends = AgentBackends::from_items(vec![AgentBackend {
            id: "aider".into(),
            name: String::new(),
            command: "aider".into(),
            args: vec!["--yes-always".into()],
        }])
        .unwrap();
        let item = backends.get("aider").unwrap();
        assert_eq!(item.name, "aider");
        assert_eq!(item.args, vec!["--yes-always"]);
    }

    #[test]
    fn empty_items_rejected() {
        assert!(AgentBackends::from_items(vec![]).is_err());
    }

    #[test]
    fn missing_command_rejected() {
        let err = AgentBackends::from_items(vec![AgentBackend {
            id: "x".into(),
            name: "x".into(),
            command: String::new(),
            args: vec![],
        }])
        .unwrap_err();
        assert!(err.to_string().contains("command is required"));
    }
}
