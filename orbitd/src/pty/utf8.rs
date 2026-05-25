#[derive(Debug, Default)]
pub struct Utf8Decoder {
    incomplete: Vec<u8>,
}

impl Utf8Decoder {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        self.incomplete.extend_from_slice(chunk);
        match std::str::from_utf8(&self.incomplete) {
            Ok(value) => {
                let out = value.to_string();
                self.incomplete.clear();
                out
            }
            Err(err) if err.error_len().is_none() => {
                let valid = err.valid_up_to();
                let out = String::from_utf8_lossy(&self.incomplete[..valid]).to_string();
                self.incomplete = self.incomplete[valid..].to_vec();
                out
            }
            Err(_) => {
                let out = String::from_utf8_lossy(&self.incomplete).to_string();
                self.incomplete.clear();
                out
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Decoder;

    #[test]
    fn buffers_incomplete_korean_sequence() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.decode(&[0xEA, 0xB0]), "");
        assert_eq!(decoder.decode(&[0x80]), "가");
    }
}
