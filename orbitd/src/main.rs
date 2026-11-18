mod adapter;
mod audit;
mod auth;
mod codex;
mod config;
mod db;
mod images;
mod pty;
mod server;
mod session;

use anyhow::Context;
use axum::Router;
use config::Config;
use server::AppState;
use session::registry::SessionRegistry;
use std::{net::SocketAddr, sync::Arc};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--web-session-worker")) {
        let socket = args.next().context("Missing Codex daemon socket")?;
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(codex::run_worker(std::path::Path::new(&socket)));
    }
    run_server()
}

#[tokio::main]
async fn run_server() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive("orbitd=info".parse()?),
        )
        .init();

    let config = Config::load().context("failed to load config")?;
    config.ensure_dirs()?;
    let token = auth::token::TokenConfig::load_or_create(&config.token_path)?;
    let db = Arc::new(db::Db::open()?);
    db.migrate()?;

    let registry = Arc::new(SessionRegistry::new(db, config.clone()));
    let state = AppState {
        registry,
        token: Arc::new(token),
    };
    let app: Router = server::routes(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = config.listen.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("orbitd listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
