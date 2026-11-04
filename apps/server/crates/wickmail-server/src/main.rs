//! Binary entry point for `wickmail-server`.
//!
//! The server runs as a long-lived process. Until the HTTP API lands, this
//! binary exposes identity reporting and a database migration command that
//! operators and tests can run.

use std::process::ExitCode;

use wickmail_server::{PRODUCT_NAME, Store, StoreError, version};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        None | Some("version" | "--version" | "-V") => {
            println!("{} {}", PRODUCT_NAME, version());
            ExitCode::SUCCESS
        }
        Some("migrate") => match args.get(2) {
            Some(path) => match migrate(path) {
                Ok(schema_version) => {
                    println!("schema version: {schema_version}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("migration failed: {error}");
                    ExitCode::FAILURE
                }
            },
            None => {
                eprintln!("usage: {PRODUCT_NAME} migrate <database>");
                ExitCode::FAILURE
            }
        },
        Some(other) => {
            eprintln!("unknown command: {other}");
            ExitCode::FAILURE
        }
    }
}

fn migrate(path: &str) -> Result<i64, StoreError> {
    let mut store = Store::open(path)?;
    store.migrate()?;
    store.schema_version()
}
