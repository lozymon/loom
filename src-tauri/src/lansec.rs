//! LAN bridge sealing (Plan 02 L1c) — the confidentiality + authentication layer over the raw
//! WebSocket transport (`lanbridge.rs`). Because `read` ships scrollback (secrets, tokens), the LAN
//! must not carry plaintext even on a trusted home network. This is NOT the flagship's Noise pairing
//! (ADR-0012 rule 6) — it is a deliberately simpler shape suited to the LAN threat model:
//!
//! - **Pre-shared key (PSK):** a random 32-byte pairing key, shown by the laptop (for a QR) and held
//!   by the phone. Requiring it is what makes binding to the LAN safe: only the paired phone can
//!   drive, because a party without the PSK derives the wrong session key and every frame fails the
//!   AEAD tag check — that failure *is* the authentication.
//! - **Per-connection session key:** `HKDF-SHA256(PSK, client_salt‖server_salt)`, salts exchanged
//!   fresh each connection. A unique key per connection is what lets us use simple counter nonces
//!   without ever repeating one under a key (the classic AEAD footgun).
//! - **Sealed frames:** ChaCha20-Poly1305, nonce = `direction‖counter`, counter strictly increasing
//!   (replay/reorder rejected). The 8-byte counter rides in front of the ciphertext so the receiver
//!   can rebuild the nonce; tampering it just changes the nonce → tag mismatch → rejected.
//!
//! Accepted tradeoff vs. Noise: **no forward secrecy** — the session key derives deterministically
//! from the PSK, so a later PSK compromise decrypts recorded LAN sessions. For a home LAN with a
//! revocable, re-pairable key this is acceptable; the flagship's from-anywhere path uses Noise.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 32;

/// A cryptographically-random 32-byte value — a pairing key or a handshake salt.
pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    b
}

/// Derive the per-connection session key: `HKDF-SHA256(ikm=PSK, salt=client‖server, info)`.
fn derive_session_key(
    psk: &[u8; KEY_LEN],
    client_salt: &[u8; SALT_LEN],
    server_salt: &[u8; SALT_LEN],
) -> [u8; 32] {
    let mut salt = [0u8; SALT_LEN * 2];
    salt[..SALT_LEN].copy_from_slice(client_salt);
    salt[SALT_LEN..].copy_from_slice(server_salt);
    let hk = Hkdf::<Sha256>::new(Some(&salt), psk);
    let mut okm = [0u8; 32];
    hk.expand(b"loom-lan-v1", &mut okm)
        .expect("hkdf expand of a fixed length never fails");
    okm
}

/// Direction byte in the nonce — keeps client→server and server→client counters from colliding under
/// the shared session key.
const DIR_CLIENT_TO_SERVER: u8 = 0;
const DIR_SERVER_TO_CLIENT: u8 = 1;

/// A sealed channel over one WS connection, from the **server's** perspective: it opens
/// client→server frames and seals server→client replies.
pub struct Sealed {
    cipher: ChaCha20Poly1305,
    send_ctr: u64,
    recv_ctr: u64,
    recv_started: bool,
}

impl Sealed {
    /// Establish the channel from the PSK and the two handshake salts.
    pub fn server(
        psk: &[u8; KEY_LEN],
        client_salt: &[u8; SALT_LEN],
        server_salt: &[u8; SALT_LEN],
    ) -> Self {
        let key = derive_session_key(psk, client_salt, server_salt);
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        Self {
            cipher,
            send_ctr: 0,
            recv_ctr: 0,
            recv_started: false,
        }
    }

    fn nonce(dir: u8, ctr: u64) -> Nonce {
        // 12 bytes: [dir(1)][counter big-endian(8)][zero(3)].
        let mut n = [0u8; 12];
        n[0] = dir;
        n[1..9].copy_from_slice(&ctr.to_be_bytes());
        *Nonce::from_slice(&n)
    }

    /// Seal a server→client message → `[counter(8)][ciphertext]`.
    pub fn seal(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let ctr = self.send_ctr;
        let ct = self
            .cipher
            .encrypt(&Self::nonce(DIR_SERVER_TO_CLIENT, ctr), plaintext)
            .expect("AEAD seal never fails with a valid key/nonce");
        self.send_ctr = self.send_ctr.wrapping_add(1);
        let mut frame = ctr.to_be_bytes().to_vec();
        frame.extend_from_slice(&ct);
        frame
    }

    /// Open a client→server `[counter(8)][ciphertext]` frame. Fails on a bad tag (wrong PSK /
    /// tampering) or a non-increasing counter (replay/reorder).
    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, ()> {
        if frame.len() < 8 {
            return Err(());
        }
        let ctr = u64::from_be_bytes(frame[0..8].try_into().unwrap());
        if self.recv_started && ctr <= self.recv_ctr {
            return Err(()); // replay or reorder
        }
        let pt = self
            .cipher
            .decrypt(&Self::nonce(DIR_CLIENT_TO_SERVER, ctr), &frame[8..])
            .map_err(|_| ())?;
        self.recv_ctr = ctr;
        self.recv_started = true;
        Ok(pt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror the client side just enough to test round-trips (the real client is the RN app).
    struct Client {
        cipher: ChaCha20Poly1305,
        send_ctr: u64,
    }
    impl Client {
        fn new(psk: &[u8; KEY_LEN], cs: &[u8; SALT_LEN], ss: &[u8; SALT_LEN]) -> Self {
            let key = derive_session_key(psk, cs, ss);
            Self {
                cipher: ChaCha20Poly1305::new(Key::from_slice(&key)),
                send_ctr: 0,
            }
        }
        fn seal(&mut self, pt: &[u8]) -> Vec<u8> {
            let ctr = self.send_ctr;
            let ct = self
                .cipher
                .encrypt(&Sealed::nonce(DIR_CLIENT_TO_SERVER, ctr), pt)
                .unwrap();
            self.send_ctr += 1;
            let mut f = ctr.to_be_bytes().to_vec();
            f.extend_from_slice(&ct);
            f
        }
    }

    #[test]
    fn round_trips_a_request_and_reply() {
        let psk = [7u8; KEY_LEN];
        let cs = [1u8; SALT_LEN];
        let ss = [2u8; SALT_LEN];
        let mut server = Sealed::server(&psk, &cs, &ss);
        let mut client = Client::new(&psk, &cs, &ss);

        let req = client.seal(b"{\"op\":\"list\"}");
        assert_eq!(server.open(&req).unwrap(), b"{\"op\":\"list\"}");
        let reply = server.seal(b"{\"ok\":true}");
        // reply is [ctr][ct] sealed under DIR_SERVER_TO_CLIENT; the client would open it symmetrically.
        assert!(reply.len() > 8);
    }

    #[test]
    fn a_wrong_psk_fails_the_tag_check() {
        let (cs, ss) = ([1u8; SALT_LEN], [2u8; SALT_LEN]);
        let mut server = Sealed::server(&[7u8; KEY_LEN], &cs, &ss);
        let mut attacker = Client::new(&[9u8; KEY_LEN], &cs, &ss); // different PSK
        let frame = attacker.seal(b"{\"op\":\"spawn\"}");
        assert!(server.open(&frame).is_err(), "no PSK ⇒ no valid frame");
    }

    #[test]
    fn a_replayed_counter_is_rejected() {
        let (psk, cs, ss) = ([7u8; KEY_LEN], [1u8; SALT_LEN], [2u8; SALT_LEN]);
        let mut server = Sealed::server(&psk, &cs, &ss);
        let mut client = Client::new(&psk, &cs, &ss);
        let f0 = client.seal(b"a");
        let f1 = client.seal(b"b");
        assert!(server.open(&f0).is_ok());
        assert!(server.open(&f1).is_ok());
        assert!(
            server.open(&f0).is_err(),
            "replay of an old counter is rejected"
        );
        assert!(
            server.open(&f1).is_err(),
            "even the most recent, once seen, cannot repeat"
        );
    }

    #[test]
    fn distinct_salts_yield_distinct_session_keys() {
        let psk = [7u8; KEY_LEN];
        let k1 = derive_session_key(&psk, &[1u8; SALT_LEN], &[2u8; SALT_LEN]);
        let k2 = derive_session_key(&psk, &[1u8; SALT_LEN], &[3u8; SALT_LEN]);
        assert_ne!(k1, k2, "a fresh server salt ⇒ a fresh session key");
    }
}
