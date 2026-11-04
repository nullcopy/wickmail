//! Minimal LMTP server and client.
//!
//! The proxy accepts LMTP from Postfix, spools the message, and forwards it to
//! Dovecot over LMTP. Only the commands the mail path needs are implemented;
//! the server always accepts recipients at the LMTP level and reports
//! per-recipient results after `DATA`.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use thiserror::Error;

/// A message accepted at `DATA`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    /// Envelope sender, without angle brackets.
    pub sender: String,
    /// Envelope recipients, without angle brackets.
    pub recipients: Vec<String>,
    /// Message bytes with dot-stuffing removed.
    pub data: Vec<u8>,
}

/// The status reported for one recipient after `DATA`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientReply {
    /// SMTP status code.
    pub code: u16,
    /// Human-readable status text.
    pub text: String,
}

impl RecipientReply {
    /// A `250` acceptance.
    pub fn accepted(text: impl Into<String>) -> Self {
        Self {
            code: 250,
            text: text.into(),
        }
    }

    /// A `451` temporary failure.
    pub fn temporary(text: impl Into<String>) -> Self {
        Self {
            code: 451,
            text: text.into(),
        }
    }
}

/// Processes an accepted envelope and returns one reply per recipient.
pub trait MessageHandler: Send + Sync {
    /// Handles a delivered message.
    fn handle(&self, envelope: Envelope) -> Vec<RecipientReply>;
}

/// Where the proxy forwards accepted mail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LmtpTarget {
    /// A Unix-domain socket.
    Unix(PathBuf),
    /// A TCP endpoint.
    Inet(String, u16),
}

impl LmtpTarget {
    /// Parses a `unix:/path` or `inet:host:port` specification.
    pub fn parse(spec: &str) -> Option<Self> {
        if let Some(path) = spec.strip_prefix("unix:") {
            return Some(Self::Unix(PathBuf::from(path)));
        }
        if let Some(rest) = spec.strip_prefix("inet:") {
            let (host, port) = rest.rsplit_once(':')?;
            return Some(Self::Inet(host.to_string(), port.parse().ok()?));
        }
        None
    }
}

/// Serves one LMTP connection until the peer disconnects.
pub fn serve_session(stream: UnixStream, handler: &dyn MessageHandler) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    write_line(&mut writer, "220 wickmail LMTP ready")?;

    let mut sender: Option<String> = None;
    let mut recipients: Vec<String> = Vec::new();

    while let Some(line) = read_line(&mut reader)? {
        let (command, rest) = split_command(&line);
        match command.as_str() {
            "LHLO" => {
                writer.write_all(b"250-wickmail\r\n250 8BITMIME\r\n")?;
                writer.flush()?;
            }
            "MAIL" => {
                sender = parse_path(rest);
                recipients.clear();
                write_line(&mut writer, "250 2.1.0 Ok")?;
            }
            "RCPT" => {
                if let Some(address) = parse_path(rest) {
                    recipients.push(address);
                }
                write_line(&mut writer, "250 2.1.5 Ok")?;
            }
            "DATA" => {
                if sender.is_none() || recipients.is_empty() {
                    write_line(&mut writer, "503 5.5.1 Bad sequence")?;
                    continue;
                }
                write_line(&mut writer, "354 End data with <CR><LF>.<CR><LF>")?;
                let data = read_data(&mut reader)?;
                let envelope = Envelope {
                    sender: sender.take().unwrap_or_default(),
                    recipients: std::mem::take(&mut recipients),
                    data,
                };
                let replies = handler.handle(envelope);
                for reply in replies {
                    write_line(&mut writer, &format!("{} {}", reply.code, reply.text))?;
                }
            }
            "RSET" => {
                sender = None;
                recipients.clear();
                write_line(&mut writer, "250 2.0.0 Ok")?;
            }
            "NOOP" => write_line(&mut writer, "250 2.0.0 Ok")?,
            "QUIT" => {
                write_line(&mut writer, "221 2.0.0 Bye")?;
                break;
            }
            _ => write_line(&mut writer, "500 5.5.1 Command unrecognized")?,
        }
    }
    Ok(())
}

/// An LMTP client that forwards messages to Dovecot.
#[derive(Clone)]
pub struct LmtpClient {
    target: LmtpTarget,
    hostname: String,
}

impl LmtpClient {
    /// Creates a client for a target and the hostname reported in `LHLO`.
    pub fn new(target: LmtpTarget, hostname: impl Into<String>) -> Self {
        Self {
            target,
            hostname: hostname.into(),
        }
    }

    /// Delivers a message to a single recipient.
    pub fn deliver(&self, sender: &str, recipient: &str, data: &[u8]) -> Result<(), LmtpError> {
        let mut connection = Connection::connect(&self.target)?;
        let greeting = connection.read_reply()?;
        expect(&greeting, 2)?;
        connection.send(&format!("LHLO {}", self.hostname))?;
        read_multiline(&mut connection)?;
        connection.send(&format!("MAIL FROM:<{sender}>"))?;
        expect(&connection.read_reply()?, 2)?;
        connection.send(&format!("RCPT TO:<{recipient}>"))?;
        expect(&connection.read_reply()?, 2)?;
        connection.send("DATA")?;
        expect(&connection.read_reply()?, 3)?;
        write_dot_stuffed(&mut connection, data)?;
        let reply = connection.read_reply()?;
        expect(&reply, 2)?;
        connection.send("QUIT")?;
        let _ = connection.read_reply();
        Ok(())
    }
}

/// Why an LMTP forward failed.
#[derive(Debug, Error)]
pub enum LmtpError {
    /// The connection or socket operation failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The peer sent a malformed reply.
    #[error("unexpected LMTP reply: {0}")]
    Protocol(String),
    /// The peer rejected the message.
    #[error("Dovecot rejected the message: {0}")]
    Rejected(String),
}

enum Stream {
    Unix(UnixStream),
    Inet(TcpStream),
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Unix(stream) => stream.read(buffer),
            Stream::Inet(stream) => stream.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Unix(stream) => stream.write(buffer),
            Stream::Inet(stream) => stream.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Unix(stream) => stream.flush(),
            Stream::Inet(stream) => stream.flush(),
        }
    }
}

struct Connection {
    reader: BufReader<Stream>,
}

impl Connection {
    fn connect(target: &LmtpTarget) -> io::Result<Self> {
        let stream = match target {
            LmtpTarget::Unix(path) => Stream::Unix(UnixStream::connect(path)?),
            LmtpTarget::Inet(host, port) => {
                Stream::Inet(TcpStream::connect((host.as_str(), *port))?)
            }
        };
        Ok(Self {
            reader: BufReader::new(stream),
        })
    }

    fn send(&mut self, line: &str) -> io::Result<()> {
        let stream = self.reader.get_mut();
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\r\n")?;
        stream.flush()
    }

    fn write_raw(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.reader.get_mut().write_all(bytes)
    }

    fn read_reply(&mut self) -> io::Result<String> {
        let mut line = String::new();
        self.reader.read_line(&mut line)?;
        Ok(line.trim_end().to_string())
    }
}

fn read_multiline(connection: &mut Connection) -> io::Result<String> {
    loop {
        let line = connection.read_reply()?;
        let continuation = line.as_bytes().get(3) == Some(&b'-');
        if !continuation {
            return Ok(line);
        }
    }
}

fn write_dot_stuffed(connection: &mut Connection, data: &[u8]) -> io::Result<()> {
    let mut start = 0;
    while start < data.len() {
        let end = data[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| start + position + 1)
            .unwrap_or(data.len());
        let mut line = &data[start..end];
        if line.ends_with(b"\n") {
            line = &line[..line.len() - 1];
        }
        if line.ends_with(b"\r") {
            line = &line[..line.len() - 1];
        }
        if line.first() == Some(&b'.') {
            connection.write_raw(b".")?;
        }
        connection.write_raw(line)?;
        connection.write_raw(b"\r\n")?;
        start = end;
    }
    connection.write_raw(b".\r\n")?;
    connection.reader.get_mut().flush()
}

fn expect(reply: &str, class: u8) -> Result<(), LmtpError> {
    let code = reply
        .split_whitespace()
        .next()
        .and_then(|token| token.parse::<u16>().ok());
    match code {
        Some(code) if code / 100 == u16::from(class) => Ok(()),
        Some(code) if code / 100 == 4 => Err(LmtpError::Rejected(reply.to_string())),
        Some(_) => Err(LmtpError::Rejected(reply.to_string())),
        None => Err(LmtpError::Protocol(reply.to_string())),
    }
}

fn read_line(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(['\r', '\n']).to_string()))
}

fn write_line(writer: &mut impl Write, line: &str) -> io::Result<()> {
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\r\n")?;
    writer.flush()
}

fn split_command(line: &str) -> (String, &str) {
    let line = line.trim_end();
    match line.split_once(' ') {
        Some((command, rest)) => (command.to_ascii_uppercase(), rest.trim()),
        None => (line.to_ascii_uppercase(), ""),
    }
}

/// Extracts the address from a `MAIL FROM:<addr> PARAMS` argument.
fn parse_path(rest: &str) -> Option<String> {
    let rest = rest.trim();
    let rest = rest
        .strip_prefix("FROM:")
        .or_else(|| rest.strip_prefix("TO:"))
        .unwrap_or(rest)
        .trim();
    let start = rest.find('<');
    let end = rest.rfind('>');
    match (start, end) {
        (Some(start), Some(end)) if end > start => Some(rest[start + 1..end].to_string()),
        _ => {
            let token = rest.split_whitespace().next().unwrap_or("");
            if token.is_empty() {
                None
            } else {
                Some(token.to_string())
            }
        }
    }
}

fn read_data(reader: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut data = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        let mut end = line.len();
        if end > 0 && line[end - 1] == b'\n' {
            end -= 1;
        }
        if end > 0 && line[end - 1] == b'\r' {
            end -= 1;
        }
        let content = &line[..end];
        if content == b"." {
            break;
        }
        let content = content.strip_prefix(b".").unwrap_or(content);
        data.extend_from_slice(content);
        data.extend_from_slice(b"\r\n");
    }
    Ok(data)
}

/// Binds an LMTP Unix socket, replacing any stale socket file.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::{
        Envelope, LmtpClient, LmtpTarget, MessageHandler, RecipientReply, bind, serve_session,
    };
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::time::Duration;

    struct EchoHandler;

    impl MessageHandler for EchoHandler {
        fn handle(&self, envelope: Envelope) -> Vec<RecipientReply> {
            envelope
                .recipients
                .iter()
                .map(|_| RecipientReply::accepted(format!("stored {}", envelope.data.len())))
                .collect()
        }
    }

    #[test]
    fn server_accepts_a_message() {
        let (server, client) = UnixStream::pair().unwrap();
        let handler = EchoHandler;
        let join = std::thread::spawn(move || serve_session(server, &handler).unwrap());

        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut writer = client;
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("220"));

        writer.write_all(b"LHLO test\r\n").unwrap();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line.starts_with("250 ") {
                break;
            }
        }
        writer
            .write_all(b"MAIL FROM:<sender@example.com>\r\n")
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("250"));
        writer.write_all(b"RCPT TO:<user@example.com>\r\n").unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("250"));
        writer.write_all(b"DATA\r\n").unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("354"));
        writer
            .write_all(b"Subject: hi\r\n\r\n..leading dot\r\n.\r\n")
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("250"), "got {line:?}");
        writer.write_all(b"QUIT\r\n").unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("221"), "got {line:?}");
        join.join().unwrap();
    }

    #[test]
    fn client_delivers_to_a_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lmtp.sock");
        let listener = bind(&path).unwrap();
        let handler = Arc::new(EchoHandler);
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_session(stream, handler.as_ref()).unwrap();
        });
        std::thread::sleep(Duration::from_millis(50));

        let client = LmtpClient::new(LmtpTarget::Unix(path), "wickmail");
        client
            .deliver(
                "sender@example.com",
                "user@example.com",
                b"Subject: hi\r\n\r\n.leading dot\r\n",
            )
            .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn parses_target_specs() {
        assert_eq!(
            LmtpTarget::parse("unix:/run/dovecot/lmtp"),
            Some(LmtpTarget::Unix("/run/dovecot/lmtp".into()))
        );
        assert_eq!(
            LmtpTarget::parse("inet:127.0.0.1:24"),
            Some(LmtpTarget::Inet("127.0.0.1".to_string(), 24))
        );
        assert_eq!(LmtpTarget::parse("bogus"), None);
    }
}
