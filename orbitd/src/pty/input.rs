use anyhow::{bail, Result};

#[derive(Debug, Default)]
pub struct InputArbiter {
    current_writer: Option<String>,
}

impl InputArbiter {
    pub fn claim(&mut self, client_id: &str) {
        self.current_writer = Some(client_id.to_string());
    }

    pub fn try_write(&mut self, client_id: &str) -> Result<()> {
        match self.current_writer.as_deref() {
            None => {
                self.current_writer = Some(client_id.to_string());
                Ok(())
            }
            Some(current) if current == client_id => Ok(()),
            Some(_) => bail!("another client owns writable attach"),
        }
    }

    pub fn release(&mut self, client_id: &str) {
        if self.current_writer.as_deref() == Some(client_id) {
            self.current_writer = None;
        }
    }
}
