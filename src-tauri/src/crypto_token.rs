//! OS-CSPRNG token minting shared by htmlview/epubview/remote_host; moved out
//! of htmlview.rs 2026-09-25 since four call sites outgrew the scripted-HTML
//! module.
//!
//! Three distinct uses share this one minter (design intent: one
//! unguessable-token primitive, not one per caller): (1) the per-open
//! **view token** that `htmlview.rs`/`epubview.rs` bind to a canonicalized
//! root — possessing it *is* the authorization (design §10.3); (2) the
//! **pairing bearer token** `remote_host::redeem` mints for a device that
//! just exchanged a short-lived pairing code; (3) the non-secret **device
//! id** `remote_host` mints alongside that bearer token so a paired device
//! has an unguessable-but-not-secret handle a UI can name it by.

/// Number of random bytes in a minted token — 128 bits, hex-encoded to 32
/// characters. Whichever of the three uses above mints it, the token (or, for
/// a device id, the id itself) must be infeasible to guess or enumerate, not
/// just "different each time".
const TOKEN_BYTES: usize = 16;

/// Mint one fresh, unguessable token: `TOKEN_BYTES` bytes from the OS CSPRNG
/// (`getrandom`, never a seeded/deterministic PRNG — a predictable token
/// would let one caller's secret be forged or enumerated), hex-encoded. Two
/// calls always differ in practice (locked by
/// `mint_token_is_not_repeated_across_calls`) precisely because they're
/// independent CSPRNG draws, not a counter.
pub(crate) fn mint_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).expect("OS CSPRNG must be available to mint a token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_token_is_32_hex_chars() {
        let token = mint_token();
        assert_eq!(token.len(), TOKEN_BYTES * 2);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "got: {token}");
    }

    #[test]
    fn mint_token_is_not_repeated_across_calls() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b, "two independent CSPRNG draws must not collide");
    }
}
