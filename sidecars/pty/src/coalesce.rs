//! Output coalescing, carried over from v1 `pty.rs` (ADR-0003 in v1, ADR-0011 in v2).
//!
//! A flood (`yes`, a big `cat`) must reach the hub as a bounded number of frames, not one frame
//! per read. Chunks are never split, and leftover chunks stay in the channel so back-pressure
//! reaches the reader thread and, through the kernel buffer, the child process.

use std::time::Duration;

/// At most one output frame per terminal per interval.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// Stop pulling more chunks into a frame once it reaches this size.
pub const FRAME_MAX: usize = 64 * 1024;
/// Chunks buffered between a reader and its flusher before the reader blocks.
pub const CHANNEL_DEPTH: usize = 16;
/// Bytes per read from the PTY.
pub const READ_BUF: usize = 8192;

/// Appends chunks from `next` to `acc` while it is under `max`. Returns how many were pulled.
pub fn coalesce_into(
    acc: &mut Vec<u8>,
    max: usize,
    mut next: impl FnMut() -> Option<Vec<u8>>,
) -> usize {
    let mut pulled = 0;
    while acc.len() < max {
        match next() {
            Some(chunk) => {
                acc.extend_from_slice(&chunk);
                pulled += 1;
            }
            None => break,
        }
    }
    pulled
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn pulls_until_the_frame_is_full_and_leaves_the_rest() {
        let mut queue: VecDeque<Vec<u8>> = (0..10).map(|_| vec![b'x'; 30]).collect();
        let mut acc = queue.pop_front().unwrap();
        let pulled = coalesce_into(&mut acc, 100, || queue.pop_front());
        assert_eq!(pulled, 3);
        assert_eq!(acc.len(), 120);
        assert_eq!(queue.len(), 6);
    }

    #[test]
    fn never_splits_a_chunk() {
        let mut queue: VecDeque<Vec<u8>> = VecDeque::from(vec![vec![1u8; 500]]);
        let mut acc = vec![0u8; 10];
        coalesce_into(&mut acc, 100, || queue.pop_front());
        assert_eq!(acc.len(), 510);
    }

    #[test]
    fn stops_when_the_channel_is_empty() {
        let mut acc = vec![0u8; 4];
        assert_eq!(coalesce_into(&mut acc, 100, || None), 0);
        assert_eq!(acc.len(), 4);
    }

    #[test]
    fn a_full_frame_pulls_nothing() {
        let mut queue: VecDeque<Vec<u8>> = VecDeque::from(vec![vec![1u8; 5]]);
        let mut acc = vec![0u8; 100];
        assert_eq!(coalesce_into(&mut acc, 100, || queue.pop_front()), 0);
        assert_eq!(queue.len(), 1);
    }
}
