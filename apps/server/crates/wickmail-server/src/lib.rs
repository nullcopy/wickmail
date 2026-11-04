//! Core library for `wickmail-server`.
//!
//! This M0 scaffold exposes only the product identity. Domain logic (alias
//! generation, lease evaluation, quarantine reconciliation, and the
//! management API) lands in later milestones.

/// Product name reported by the server and used in diagnostics.
pub const PRODUCT_NAME: &str = "wickmail-server";

/// Version of the running server, taken from the crate metadata.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::{PRODUCT_NAME, version};

    #[test]
    fn product_name_is_stable() {
        assert_eq!(PRODUCT_NAME, "wickmail-server");
    }

    #[test]
    fn version_is_not_empty() {
        assert!(!version().is_empty());
    }
}
