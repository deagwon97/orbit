use chrono::{DateTime, Utc};
use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct ScrollbackLine {
    #[allow(dead_code)]
    pub timestamp: DateTime<Utc>,
    pub content: Vec<u8>,
}

#[derive(Debug)]
pub struct ScrollbackBuffer {
    lines: VecDeque<ScrollbackLine>,
    max_lines: usize,
    max_bytes: usize,
    total_bytes: usize,
}

impl ScrollbackBuffer {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            max_lines,
            max_bytes,
            total_bytes: 0,
        }
    }

    pub fn push(&mut self, content: Vec<u8>) {
        self.total_bytes += content.len();
        self.lines.push_back(ScrollbackLine {
            timestamp: Utc::now(),
            content,
        });
        while self.lines.len() > self.max_lines || self.total_bytes > self.max_bytes {
            if let Some(line) = self.lines.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(line.content.len());
            } else {
                break;
            }
        }
    }

    pub fn get_last_n(&self, n: usize) -> Vec<ScrollbackLine> {
        self.lines
            .iter()
            .rev()
            .take(n)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::ScrollbackBuffer;

    #[test]
    fn evicts_by_line_count() {
        let mut buf = ScrollbackBuffer::new(2, 1024);
        buf.push(b"one".to_vec());
        buf.push(b"two".to_vec());
        buf.push(b"three".to_vec());
        let lines = buf.get_last_n(10);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].content, b"two");
    }
}
