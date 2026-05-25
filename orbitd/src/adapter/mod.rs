use orb_common::ToolType;

pub trait ToolAdapter: Send + Sync {
    fn executable(&self) -> &'static str;
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
adapter!(ClaudeCodeAdapter, ToolType::ClaudeCode, "claude");
adapter!(OpenCodeAdapter, ToolType::Opencode, "opencode");
adapter!(PiAdapter, ToolType::Pi, "pi");

pub fn executable_for(tool: &ToolType) -> &'static str {
    match tool {
        ToolType::Codex => CodexAdapter.executable(),
        ToolType::ClaudeCode => ClaudeCodeAdapter.executable(),
        ToolType::Opencode => OpenCodeAdapter.executable(),
        ToolType::Pi => PiAdapter.executable(),
    }
}
