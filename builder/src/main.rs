use std::net::SocketAddr;

use axum::Router;
use tower_http::{cors::CorsLayer, services::ServeDir};

fn main() {
    assert!(
        std::process::Command::new("wasm-pack")
            .args(["build", "--target", "web"])
            .current_dir("ffst-parts-onshape")
            .spawn()
            .unwrap()
            .wait()
            .unwrap()
            .success()
    );
    std::fs::copy("ffst-parts-onshape/pkg/ffst_parts_onshape.js", "output/ffst_parts_onshape.js").unwrap();
    std::fs::copy("ffst-parts-onshape/pkg/ffst_parts_onshape_bg.wasm", "output/ffst_parts_onshape_bg.wasm").unwrap();

    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let router = Router::new().fallback_service(ServeDir::new("output")).layer(CorsLayer::permissive());

        let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

        axum::serve(listener, router).await.unwrap();
    });
}
