//! Postfix socketmap server for the RCPT policy lookup.
//!
//! Postfix's `socketmap` table type exchanges netstring-framed messages over a
//! Unix socket. A request is `"<map-name> <key>"`; a reply is `OK <value>`,
//! `NOTFOUND`, `TEMP <reason>`, `TIMEOUT`, or `PERM <reason>`. The lookup is
//! wired into `smtpd_recipient_restrictions` through `check_recipient_access`,
//! so the returned value is an access decision: `OK` accepts the recipient and
//! `REJECT <text>` rejects it with a permanent failure.

use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;

use crate::mail::policy::{PolicyDecision, RecipientPolicy};

/// Default socketmap name used in the Postfix table specification.
pub const DEFAULT_SOCKETMAP_NAME: &str = "wickmail-policy";

/// Builds the reply payload for a request.
pub fn reply_for(name: &str, payload: &[u8], policy: &RecipientPolicy) -> String {
    let text = String::from_utf8_lossy(payload);
    let (map_name, key) = text.split_once(' ').unwrap_or((text.as_ref(), ""));
    if map_name != name {
        return "NOTFOUND".to_string();
    }
    match policy.decide(key) {
        PolicyDecision::Accept => "OK OK".to_string(),
        PolicyDecision::Reject(reason) => format!("OK REJECT {reason}"),
        PolicyDecision::Temporary(reason) => format!("TEMP {reason}"),
    }
}

/// Serves one socketmap connection until the peer closes it.
pub fn serve_connection(
    stream: UnixStream,
    name: &str,
    policy: &RecipientPolicy,
) -> io::Result<()> {
    serve_connection_with(stream, |payload| reply_for(name, payload, policy))
}

/// Serves one socketmap connection with a caller-supplied reply function.
///
/// The function receives each netstring payload and returns the reply string.
/// This lets the submission ownership check reuse the netstring framing.
pub fn serve_connection_with<F>(stream: UnixStream, reply: F) -> io::Result<()>
where
    F: Fn(&[u8]) -> String,
{
    let mut reader = stream.try_clone()?;
    let mut writer = stream;
    while let Some(payload) = read_netstring(&mut reader)? {
        let response = reply(&payload);
        write_netstring(&mut writer, response.as_bytes())?;
    }
    Ok(())
}

/// Binds a socketmap Unix socket, replacing any stale socket file.
pub fn bind(path: &Path) -> io::Result<std::os::unix::net::UnixListener> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = std::os::unix::net::UnixListener::bind(path)?;
    // Postfix connects as an unprivileged process; the lookup carries no
    // secrets, so the socket is world-accessible.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    Ok(listener)
}

/// Reads one netstring, or `None` on a clean end of stream.
pub fn read_netstring<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => {
                return if length.is_empty() {
                    Ok(None)
                } else {
                    Err(invalid("truncated netstring length"))
                };
            }
            Ok(_) => {
                if byte[0] == b':' {
                    break;
                }
                if !byte[0].is_ascii_digit() || length.len() >= 20 {
                    return Err(invalid("invalid netstring length"));
                }
                length.push(byte[0]);
            }
            Err(error) => return Err(error),
        }
    }
    if length.is_empty() {
        return Err(invalid("empty netstring length"));
    }
    let length: usize = std::str::from_utf8(&length)
        .map_err(|_| invalid("non-utf8 netstring length"))?
        .parse()
        .map_err(|_| invalid("invalid netstring length"))?;
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload)?;
    let mut terminator = [0u8; 1];
    reader.read_exact(&mut terminator)?;
    if terminator[0] != b',' {
        return Err(invalid("missing netstring terminator"));
    }
    Ok(Some(payload))
}

/// Writes one netstring and flushes it.
pub fn write_netstring<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    write!(writer, "{}:", payload.len())?;
    writer.write_all(payload)?;
    writer.write_all(b",")?;
    writer.flush()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

#[cfg(test)]
mod tests {
    use super::{read_netstring, reply_for, write_netstring};
    use crate::address::{CanonicalAddress, Domain};
    use crate::clock::FixedClock;
    use crate::db::Store;
    use crate::generator::AliasGenerator;
    use crate::mail::policy::RecipientPolicy;
    use crate::service::AliasService;
    use crate::timestamp::Timestamp;
    use std::sync::{Arc, Mutex};

    fn policy() -> RecipientPolicy {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let service = AliasService::new(
            store,
            AliasGenerator::from_words(vec!["green", "farm"]),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(
                "2026-01-04T00:00:00Z".parse::<Timestamp>().unwrap(),
            )),
        );
        RecipientPolicy::new(
            CanonicalAddress::parse("user@example.com").unwrap(),
            Arc::new(Mutex::new(service)),
        )
    }

    #[test]
    fn netstring_round_trips() {
        let mut buffer = Vec::new();
        write_netstring(&mut buffer, b"hello world").unwrap();
        assert_eq!(buffer, b"11:hello world,");
        let mut cursor = std::io::Cursor::new(buffer);
        assert_eq!(
            read_netstring(&mut cursor).unwrap(),
            Some(b"hello world".to_vec())
        );
        assert_eq!(read_netstring(&mut cursor).unwrap(), None);
    }

    #[test]
    fn replies_map_to_access_decisions() {
        let policy = policy();
        assert_eq!(
            reply_for(
                "wickmail-policy",
                b"wickmail-policy user@example.com",
                &policy
            ),
            "OK OK"
        );
        let reply = reply_for(
            "wickmail-policy",
            b"wickmail-policy nobody@example.com",
            &policy,
        );
        assert!(reply.starts_with("OK REJECT"), "got {reply:?}");
        assert_eq!(
            reply_for("wickmail-policy", b"other user@example.com", &policy),
            "NOTFOUND"
        );
    }

    #[test]
    fn rejects_a_malformed_request() {
        let policy = policy();
        assert_eq!(
            reply_for("wickmail-policy", b"wickmail-policy", &policy),
            "OK REJECT unknown recipient"
        );
    }
}
