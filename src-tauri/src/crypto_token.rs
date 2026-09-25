//! OS-CSPRNG token minting shared by htmlview/epubview/remote_host; moved out
//! of htmlview.rs 2026-09-25 since four call sites outgrew the scripted-HTML
//! module.

/// Number of random bytes in a minted view token — 128 bits, hex-encoded to
/// 32 characters. This is the entire access-control secret for a scripted
/// open: possessing the token *is* the authorization (design §10.3), so it
/// must be infeasible to guess or enumerate, not just "different each time".
const VIEW_TOKEN_BYTES: usize = 16;

/// Mint one fresh, unguessable view token: `VIEW_TOKEN_BYTES` bytes from the
/// OS CSPRNG (`getrandom`, never a seeded/deterministic PRNG — a predictable
/// token would let one open's document forge another's URL and reach a root
/// it was never armed for), hex-encoded. Two calls always differ in practice
/// (locked by `mint_view_token_is_not_repeated_across_calls`) precisely
/// because they're independent CSPRNG draws, not a counter.
pub(crate) fn mint_view_token() -> String {
    let mut bytes = [0u8; VIEW_TOKEN_BYTES];
    getrandom::fill(&mut bytes).expect("OS CSPRNG must be available to mint a view token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_view_token_is_32_hex_chars() {
        let token = mint_view_token();
        assert_eq!(token.len(), VIEW_TOKEN_BYTES * 2);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "got: {token}");
    }

    #[test]
    fn mint_view_token_is_not_repeated_across_calls() {
        let a = mint_view_token();
        let b = mint_view_token();
        assert_ne!(a, b, "two independent CSPRNG draws must not collide");
    }
}
