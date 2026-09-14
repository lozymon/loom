//! Audio helpers that need no model, so they can be unit-tested.

pub const SAMPLE_RATE: usize = 16_000;

/// Signed 16-bit little-endian PCM to floats in [-1, 1). A trailing odd byte is ignored.
pub fn pcm16_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

/// Whisper rejects clips shorter than a second; pad with silence.
pub fn pad_to_one_second(mut samples: Vec<f32>) -> Vec<f32> {
    if samples.len() < SAMPLE_RATE {
        samples.resize(SAMPLE_RATE, 0.0);
    }
    samples
}

/// Chooses between English and Portuguese: a requested language wins, otherwise the more probable of
/// the two. Other languages whisper might prefer (Spanish, Galician) are not candidates.
pub fn pick_language(requested: Option<&str>, p_en: f32, p_pt: f32) -> &'static str {
    match requested.map(str::trim) {
        Some("en") => "en",
        Some("pt") => "pt",
        _ if p_pt > p_en => "pt",
        _ => "en",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_pcm16() {
        let bytes = [0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x01];
        assert_eq!(pcm16_to_f32(&bytes), vec![0.0, 32767.0 / 32768.0, -1.0]);
    }

    #[test]
    fn pads_short_clips() {
        assert_eq!(pad_to_one_second(vec![0.5; 10]).len(), SAMPLE_RATE);
        assert_eq!(
            pad_to_one_second(vec![0.5; SAMPLE_RATE * 2]).len(),
            SAMPLE_RATE * 2
        );
    }

    #[test]
    fn picks_between_english_and_portuguese() {
        assert_eq!(pick_language(None, 0.2, 0.7), "pt");
        assert_eq!(pick_language(Some("auto"), 0.6, 0.1), "en");
        assert_eq!(pick_language(Some("pt"), 0.9, 0.0), "pt");
        assert_eq!(pick_language(Some("en"), 0.0, 0.9), "en");
    }
}
