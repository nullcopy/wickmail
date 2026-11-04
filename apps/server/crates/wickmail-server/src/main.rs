//! Binary entry point for `wickmail-server`.
//!
//! The server runs as a long-lived process. This stub only reports its
//! identity; the socketmap endpoint, LMTP proxy, and management API are
//! added in later milestones.

fn main() {
    println!(
        "{} {}",
        wickmail_server::PRODUCT_NAME,
        wickmail_server::version()
    );
}
