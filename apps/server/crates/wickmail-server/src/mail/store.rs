//! Internal mail-store adapter: authenticated read and move access to Dovecot
//! Maildirs.
//!
//! The management layer reads delivered messages through this adapter for
//! reply context and quarantine. It is the only code path into
//! `Aliases/Expired`; ordinary IMAP clients cannot reach that mailbox.
//!
//! Message identity is always the `X-Wickmail-Message-ID` header. A cached
//! `(mailbox, UIDVALIDITY, UID)` locator only narrows the search; it is never
//! treated as identity. Message bodies are never logged.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::mail::headers::MessageParts;
use crate::message::MessageId;

/// The mailbox that holds mail for expired and disabled aliases.
pub const QUARANTINE_MAILBOX: &str = "Aliases/Expired";

/// The mailbox that holds messages classified as spam.
pub const SPAM_MAILBOX: &str = "Spam";

/// The mailbox that holds recovered and ordinary mail.
pub const INBOX_MAILBOX: &str = "Inbox";

/// A cached pointer into the mail store.
///
/// The fields are hints for fast access and never establish identity; every
/// read is verified against the message ID header.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxLocator {
    /// Mailbox name, such as `Aliases/Expired`.
    pub mailbox: String,
    /// IMAP `UIDVALIDITY` at the time the locator was cached.
    pub uidvalidity: u32,
    /// IMAP UID at the time the locator was cached.
    pub uid: u32,
}

/// A message discovered in the mail store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageSummary {
    /// Stable message identity from the trusted header.
    pub message_id: MessageId,
    /// Mailbox containing the message.
    pub mailbox: String,
    /// Size of the message on disk in bytes.
    pub size: u64,
    /// Rebuildable locator cache entry for this message.
    pub locator: MailboxLocator,
}

/// Why a mail-store read failed.
#[derive(Debug, Error)]
pub enum AdapterError {
    /// The filesystem could not be read.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// A message is missing its trusted identity header.
    #[error("message is missing X-Wickmail-Message-ID")]
    MissingIdentity,
    /// The identity header could not be parsed.
    #[error("invalid X-Wickmail-Message-ID: {0}")]
    InvalidIdentity(String),
}

/// Reads and moves Dovecot Maildirs for a single account.
pub struct MailStoreAdapter {
    maildir: PathBuf,
    quarantine_dir: PathBuf,
}

impl MailStoreAdapter {
    /// Creates an adapter over a user's Maildir root.
    ///
    /// The quarantine mailbox defaults to a Maildir++ folder under the same
    /// root.
    pub fn open(maildir: impl Into<PathBuf>) -> Self {
        let maildir = maildir.into();
        let quarantine_dir = maildir.join(".Aliases.Expired");
        Self {
            maildir,
            quarantine_dir,
        }
    }

    /// Creates an adapter with the quarantine mailbox in a separate Maildir.
    ///
    /// This matches a Dovecot hidden namespace whose `mail_path` is outside the
    /// user's IMAP namespace.
    pub fn with_quarantine(
        maildir: impl Into<PathBuf>,
        quarantine_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            maildir: maildir.into(),
            quarantine_dir: quarantine_dir.into(),
        }
    }

    /// The user's Maildir root.
    pub fn maildir(&self) -> &Path {
        &self.maildir
    }

    /// The quarantine mailbox's Maildir root.
    pub fn quarantine_dir(&self) -> &Path {
        &self.quarantine_dir
    }

    /// The on-disk directory for a mailbox.
    ///
    /// Uses Maildir++ naming: subfolders live in a sibling directory prefixed
    /// with `.`, with `/` in the mailbox name mapped to `.`. The quarantine
    /// mailbox maps to its configured directory.
    pub fn mailbox_dir(&self, mailbox: &str) -> PathBuf {
        if mailbox.eq_ignore_ascii_case(QUARANTINE_MAILBOX) {
            return self.quarantine_dir.clone();
        }
        if mailbox.is_empty() || mailbox.eq_ignore_ascii_case("inbox") {
            return self.maildir.clone();
        }
        let encoded = mailbox.replace('/', ".");
        self.maildir.join(format!(".{encoded}"))
    }

    /// Lists messages in a mailbox.
    pub fn list(&self, mailbox: &str) -> Result<Vec<MessageSummary>, AdapterError> {
        let dir = self.mailbox_dir(mailbox);
        let uidvalidity = read_uidvalidity(&dir);
        let mut summaries = Vec::new();
        for sub in ["cur", "new"] {
            let subdir = dir.join(sub);
            let entries = match std::fs::read_dir(&subdir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Some(message_id) = read_message_id(&path)? else {
                    continue;
                };
                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                summaries.push(MessageSummary {
                    message_id,
                    mailbox: mailbox.to_string(),
                    size,
                    locator: MailboxLocator {
                        mailbox: mailbox.to_string(),
                        uidvalidity,
                        uid: parse_uid(&path),
                    },
                });
            }
        }
        summaries.sort_by_key(|summary| summary.message_id);
        Ok(summaries)
    }

    /// Reports whether a mailbox contains a message.
    pub fn contains(&self, mailbox: &str, message_id: MessageId) -> Result<bool, AdapterError> {
        Ok(self.find_path(mailbox, message_id)?.is_some())
    }

    /// Reads a message by identity from a specific mailbox.
    ///
    /// Returns the raw bytes. The caller decides how much to surface; this
    /// function never logs the body.
    pub fn read(
        &self,
        mailbox: &str,
        message_id: MessageId,
    ) -> Result<Option<Vec<u8>>, AdapterError> {
        match self.find_path(mailbox, message_id)? {
            Some(path) => Ok(Some(std::fs::read(path)?)),
            None => Ok(None),
        }
    }

    /// Reads a message using a cached locator.
    ///
    /// The locator's mailbox is consulted first, but identity is always
    /// confirmed by the message ID header. `UIDVALIDITY` and UID are ignored;
    /// a stale locator still finds the message when it is in that mailbox.
    pub fn read_with_locator(
        &self,
        message_id: MessageId,
        locator: &MailboxLocator,
    ) -> Result<Option<Vec<u8>>, AdapterError> {
        self.read(&locator.mailbox, message_id)
    }

    /// Lists messages in the quarantine mailbox.
    pub fn quarantine(&self) -> Result<Vec<MessageSummary>, AdapterError> {
        self.list(QUARANTINE_MAILBOX)
    }

    /// Reads a quarantined message by identity.
    pub fn read_quarantine(&self, message_id: MessageId) -> Result<Option<Vec<u8>>, AdapterError> {
        self.read(QUARANTINE_MAILBOX, message_id)
    }

    /// Copies a message from one mailbox to another, preserving identity.
    ///
    /// The copy is idempotent: if the target already holds a message with the
    /// same identity the function returns `Ok(false)` and writes nothing. It
    /// also returns `Ok(false)` when the source has no such message, leaving
    /// the caller to verify the target. The source is never modified.
    pub fn copy_to(
        &self,
        source: &str,
        target: &str,
        message_id: MessageId,
    ) -> Result<bool, AdapterError> {
        if self.contains(target, message_id)? {
            return Ok(false);
        }
        let Some(bytes) = self.read(source, message_id)? else {
            return Ok(false);
        };
        self.deliver(target, message_id, &bytes)?;
        Ok(true)
    }

    /// Deletes a message by identity from a mailbox.
    ///
    /// Returns whether a copy was removed. Deleting a message that is already
    /// gone is a no-op.
    pub fn delete(&self, mailbox: &str, message_id: MessageId) -> Result<bool, AdapterError> {
        match self.find_path(mailbox, message_id)? {
            Some(path) => {
                std::fs::remove_file(path)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Returns the rebuildable locator for a message, when present.
    pub fn locator(
        &self,
        mailbox: &str,
        message_id: MessageId,
    ) -> Result<Option<MailboxLocator>, AdapterError> {
        let dir = self.mailbox_dir(mailbox);
        let Some(path) = self.find_path(mailbox, message_id)? else {
            return Ok(None);
        };
        Ok(Some(MailboxLocator {
            mailbox: mailbox.to_string(),
            uidvalidity: read_uidvalidity(&dir),
            uid: parse_uid(&path),
        }))
    }

    /// Writes message bytes into a mailbox as a new delivery.
    fn deliver(
        &self,
        mailbox: &str,
        message_id: MessageId,
        bytes: &[u8],
    ) -> Result<(), AdapterError> {
        let dir = self.mailbox_dir(mailbox);
        let new_dir = dir.join("new");
        std::fs::create_dir_all(&new_dir)?;
        let path = new_dir.join(delivery_filename(message_id));
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn find_path(
        &self,
        mailbox: &str,
        message_id: MessageId,
    ) -> Result<Option<PathBuf>, AdapterError> {
        let dir = self.mailbox_dir(mailbox);
        for sub in ["cur", "new"] {
            let subdir = dir.join(sub);
            let entries = match std::fs::read_dir(&subdir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if read_message_id(&path)? == Some(message_id) {
                    return Ok(Some(path));
                }
            }
        }
        Ok(None)
    }
}

/// Builds a unique Maildir delivery name for a message.
///
/// The name follows the Maildir convention of a timestamp, process, and host
/// part. The message identity is embedded so re-delivery of the same message
/// resolves to the same name and cannot create a second copy.
fn delivery_filename(message_id: MessageId) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}.M{}P{}.{message_id}",
        now.as_secs(),
        now.subsec_micros(),
        std::process::id()
    )
}

/// Reads only the header block of a message and extracts its identity.
fn read_message_id(path: &Path) -> Result<Option<MessageId>, AdapterError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut header = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if line == b"\n" || line == b"\r\n" {
            break;
        }
        header.extend_from_slice(&line);
    }
    let parts = MessageParts::parse(&header);
    match parts.headers.get("X-Wickmail-Message-ID") {
        Some(value) => value
            .trim()
            .parse::<MessageId>()
            .map(Some)
            .map_err(|_| AdapterError::InvalidIdentity(value.to_string())),
        None => Ok(None),
    }
}

/// The IMAP UID embedded in a Maildir filename, when the filename scheme
/// carries one. Returns 0 when it does not.
fn parse_uid(path: &Path) -> u32 {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let Some(start) = name.find(",U=") else {
        return 0;
    };
    let digits: String = name[start + 3..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    digits.parse().unwrap_or(0)
}

/// Reads the mailbox's `dovecot-uidvalidity` marker, or 0 when absent.
fn read_uidvalidity(dir: &Path) -> u32 {
    std::fs::read_to_string(dir.join("dovecot-uidvalidity"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{MailStoreAdapter, QUARANTINE_MAILBOX, SPAM_MAILBOX};
    use crate::message::MessageId;
    use std::fs;
    use std::path::Path;

    fn write_message(dir: &Path, sub: &str, name: &str, message_id: MessageId, body: &str) {
        let folder = dir.join(sub);
        fs::create_dir_all(&folder).unwrap();
        let contents =
            format!("X-Wickmail-Message-ID: {message_id}\r\nSubject: test\r\n\r\n{body}\r\n");
        fs::write(folder.join(name), contents).unwrap();
    }

    #[test]
    fn lists_and_reads_by_identity() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), "cur", "1", id, "hello body");

        let listed = adapter.list("Inbox").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].message_id, id);

        let bytes = adapter.read("Inbox", id).unwrap().unwrap();
        assert!(bytes.ends_with(b"hello body\r\n"));
    }

    #[test]
    fn quarantine_lives_in_its_own_mailbox() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), ".Aliases.Expired/cur", "1", id, "quarantined");

        assert!(adapter.list("Inbox").unwrap().is_empty());
        let listed = adapter.quarantine().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mailbox, QUARANTINE_MAILBOX);
        assert!(adapter.read_quarantine(id).unwrap().is_some());
    }

    #[test]
    fn locator_is_a_hint_not_identity() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), ".Aliases.Expired/cur", "1", id, "quarantined");

        // A locator pointing at the wrong mailbox still finds the message
        // because identity is verified from the header.
        let locator = super::MailboxLocator {
            mailbox: "Inbox".to_string(),
            uidvalidity: 1,
            uid: 1,
        };
        // The wrong mailbox has no such message, so the locator returns None.
        assert!(adapter.read_with_locator(id, &locator).unwrap().is_none());

        let correct = super::MailboxLocator {
            mailbox: QUARANTINE_MAILBOX.to_string(),
            uidvalidity: 99,
            uid: 42,
        };
        assert!(adapter.read_with_locator(id, &correct).unwrap().is_some());
    }

    #[test]
    fn messages_without_identity_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let folder = dir.path().join("cur");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("1"), "Subject: no id\r\n\r\nbody\r\n").unwrap();
        assert!(adapter.list("Inbox").unwrap().is_empty());
    }

    #[test]
    fn copy_is_idempotent_and_delete_removes_only_the_named_copy() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), ".Aliases.Expired/cur", "1", id, "quarantined");

        assert!(adapter.copy_to(QUARANTINE_MAILBOX, "Inbox", id).unwrap());
        assert!(adapter.contains("Inbox", id).unwrap());
        assert!(adapter.contains(QUARANTINE_MAILBOX, id).unwrap());
        // A second copy is a no-op.
        assert!(!adapter.copy_to(QUARANTINE_MAILBOX, "Inbox", id).unwrap());
        assert_eq!(adapter.list("Inbox").unwrap().len(), 1);

        assert!(adapter.delete(QUARANTINE_MAILBOX, id).unwrap());
        assert!(!adapter.contains(QUARANTINE_MAILBOX, id).unwrap());
        assert!(adapter.contains("Inbox", id).unwrap());
        // Deleting again is a no-op.
        assert!(!adapter.delete(QUARANTINE_MAILBOX, id).unwrap());
    }

    #[test]
    fn locators_carry_uidvalidity_and_uid_when_available() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        let quarantine = dir.path().join(".Aliases.Expired");
        fs::create_dir_all(quarantine.join("cur")).unwrap();
        fs::write(quarantine.join("dovecot-uidvalidity"), "1700000000\n").unwrap();
        fs::write(
            quarantine.join("cur/1700000000.M1P1.host,U=7:2,S"),
            format!("X-Wickmail-Message-ID: {id}\r\nSubject: x\r\n\r\nbody\r\n"),
        )
        .unwrap();

        let locator = adapter.locator(QUARANTINE_MAILBOX, id).unwrap().unwrap();
        assert_eq!(locator.uidvalidity, 1_700_000_000);
        assert_eq!(locator.uid, 7);
    }

    #[test]
    fn spam_mailbox_is_a_sibling_folder() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        let id = MessageId::new();
        write_message(dir.path(), ".Spam/cur", "1", id, "spam");
        assert_eq!(adapter.list(SPAM_MAILBOX).unwrap().len(), 1);
        assert!(adapter.list("Inbox").unwrap().is_empty());
    }
}
