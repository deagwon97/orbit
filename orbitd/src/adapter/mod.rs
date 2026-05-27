use orb_common::ToolType;

pub trait ToolAdapter: Send + Sync {
    fn executable(&self) -> &'static str;
    fn args(&self) -> &'static [&'static str] {
        &[]
    }
}

macro_rules! adapter {
    ($name:ident, $tool:expr, $exe:expr) => {
        pub struct $name;
        impl ToolAdapter for $name {
            fn executable(&self) -> &'static str {
                $exe
            }
        }
    };
}

adapter!(CodexAdapter, ToolType::Codex, "codex");
adapter!(OpenCodeAdapter, ToolType::Opencode, "opencode");
adapter!(PiAdapter, ToolType::Pi, "pi");

pub struct ClaudeCodeAdapter;
impl ToolAdapter for ClaudeCodeAdapter {
    fn executable(&self) -> &'static str {
        "claude"
    }
    fn args(&self) -> &'static [&'static str] {
        &["--dangerously-skip-permissions"]
    }
}

pub fn executable_for(tool: &ToolType) -> &'static str {
    match tool {
        ToolType::Codex => CodexAdapter.executable(),
        ToolType::ClaudeCode => ClaudeCodeAdapter.executable(),
        ToolType::Opencode => OpenCodeAdapter.executable(),
        ToolType::Pi => PiAdapter.executable(),
    }
}

pub fn args_for(tool: &ToolType) -> &'static [&'static str] {
    match tool {
        ToolType::Codex => CodexAdapter.args(),
        ToolType::ClaudeCode => ClaudeCodeAdapter.args(),
        ToolType::Opencode => OpenCodeAdapter.args(),
        ToolType::Pi => PiAdapter.args(),
    }
}
