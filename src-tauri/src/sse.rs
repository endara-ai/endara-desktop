//! Server-Sent Events (SSE) frame parser used by the overlay tool-call event
//! bridge. The parser is intentionally narrow: it consumes an
//! [`AsyncBufRead`] line by line and yields one [`SseFrame`] per dispatch
//! (i.e. one blank-line-terminated record).
//!
//! Spec reference: <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
//!
//! Supported fields:
//! - `data:` (concatenated with `\n` across repeated lines per spec).
//! - `event:` (used by the relay to signal `lagged` keep-alives).
//! - `:` comments and empty `data:` lines (skipped).
//!
//! Tolerances:
//! - Leading UTF-8 BOM on the first line.
//! - `\r\n` and bare `\n` line terminators (handled by `AsyncBufReadExt::lines`).
//! - Partial frames spanning multiple reads (lines come back as they arrive).
//! - Single optional space after the field colon.
//!
//! Unsupported on purpose: `id:` and `retry:` — the relay does not emit them
//! and the overlay does not need them.
//!
//! Frames with no `data:` field after a blank-line dispatch are skipped (per
//! spec). Frames with `event:` only (no `data:`) are also skipped.
//! Comments (`:` prefix) and unknown fields are silently ignored.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// One dispatched SSE record. `event` defaults to `"message"` if not
/// specified by the server. `data` is the concatenated payload with `\n`
/// separators between repeated `data:` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
}

impl SseFrame {
    fn new() -> Self {
        Self {
            event: String::new(),
            data: String::new(),
        }
    }

    fn is_empty(&self) -> bool {
        self.event.is_empty() && self.data.is_empty()
    }
}

/// Read the next dispatched SSE frame from `reader`. Returns `Ok(None)` on
/// clean EOF, `Ok(Some(frame))` for every blank-line-terminated record with
/// at least one `data:` field, and `Err` on I/O failure.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<SseFrame>> {
    let mut buf = String::new();
    let mut frame = SseFrame::new();
    let mut have_data = false;
    let mut first_line = true;
    loop {
        buf.clear();
        let n = reader.read_line(&mut buf).await?;
        if n == 0 {
            // EOF — return the buffered frame if any data was collected, else None.
            if have_data {
                return Ok(Some(frame));
            }
            return Ok(None);
        }
        // Trim a single trailing \n / \r\n that `read_line` includes.
        let line = strip_eol(&buf);
        // Strip a UTF-8 BOM only on the very first line of the stream.
        let line = if first_line { strip_bom(line) } else { line };
        first_line = false;
        if line.is_empty() {
            // Blank line => dispatch (only if we have a data field).
            if have_data {
                if frame.event.is_empty() {
                    frame.event = "message".to_string();
                }
                return Ok(Some(frame));
            }
            // No data accumulated — discard any partial frame state (e.g.
            // a lone `event:` line) so it doesn't bleed into the next
            // dispatched frame.
            frame = SseFrame::new();
            continue;
        }
        if let Some(rest) = line.strip_prefix(':') {
            // Comment / keep-alive — ignore.
            let _ = rest;
            continue;
        }
        let (field, value) = split_field(line);
        match field {
            "data" => {
                if have_data {
                    frame.data.push('\n');
                }
                frame.data.push_str(value);
                have_data = true;
            }
            "event" => {
                frame.event = value.to_string();
            }
            // id / retry / unknown fields are ignored.
            _ => {}
        }
        // If the buffered frame is still empty, keep reading without changing anything.
        let _ = frame.is_empty();
    }
}

fn strip_eol(s: &str) -> &str {
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.strip_suffix('\r').unwrap_or(s)
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn split_field(line: &str) -> (&str, &str) {
    match line.find(':') {
        Some(idx) => {
            let (field, rest) = line.split_at(idx);
            // Skip the colon, then up to one space.
            let value = &rest[1..];
            let value = value.strip_prefix(' ').unwrap_or(value);
            (field, value)
        }
        None => (line, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    async fn collect(input: &[u8]) -> Vec<SseFrame> {
        let mut reader = BufReader::new(input);
        let mut frames = Vec::new();
        while let Some(f) = read_frame(&mut reader).await.unwrap() {
            frames.push(f);
        }
        frames
    }

    #[tokio::test]
    async fn parses_single_data_frame() {
        let frames = collect(b"data: hello\n\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event, "message");
        assert_eq!(frames[0].data, "hello");
    }

    #[tokio::test]
    async fn concatenates_multi_line_data() {
        let frames = collect(b"data: line1\ndata: line2\n\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "line1\nline2");
    }

    #[tokio::test]
    async fn captures_event_field() {
        let frames = collect(b"event: lagged\ndata: 42\n\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event, "lagged");
        assert_eq!(frames[0].data, "42");
    }

    #[tokio::test]
    async fn ignores_comment_keepalives() {
        let frames = collect(b": keep-alive\n\ndata: x\n\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "x");
    }

    #[tokio::test]
    async fn handles_crlf_line_endings() {
        let frames = collect(b"data: a\r\ndata: b\r\n\r\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "a\nb");
    }

    #[tokio::test]
    async fn strips_leading_bom() {
        let mut bytes = b"\xef\xbb\xbfdata: x\n\n".to_vec();
        bytes.extend_from_slice(b"data: y\n\n");
        let frames = collect(&bytes).await;
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "x");
        assert_eq!(frames[1].data, "y");
    }

    #[tokio::test]
    async fn handles_two_frames_in_one_read() {
        let frames = collect(b"data: a\n\ndata: b\n\n").await;
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "a");
        assert_eq!(frames[1].data, "b");
    }

    #[tokio::test]
    async fn dispatches_remaining_buffered_frame_at_eof() {
        // No trailing blank line — still return the buffered frame at EOF.
        let frames = collect(b"data: tail").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "tail");
    }

    #[tokio::test]
    async fn empty_stream_yields_nothing() {
        let frames = collect(b"").await;
        assert!(frames.is_empty());
    }

    #[tokio::test]
    async fn blank_separator_does_not_emit_empty_frame() {
        let frames = collect(b"\n\n\n").await;
        assert!(frames.is_empty());
    }

    #[tokio::test]
    async fn event_without_data_is_skipped() {
        let frames = collect(b"event: lagged\n\ndata: y\n\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event, "message");
        assert_eq!(frames[0].data, "y");
    }

    #[tokio::test]
    async fn field_without_space_after_colon() {
        let frames = collect(b"data:no-space\n\n").await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "no-space");
    }
}
