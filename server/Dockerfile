# Multi-stage build for a small runtime image.

FROM rust:1.82-slim AS builder
WORKDIR /app

# Cache dependencies first
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && \
    cargo build --release && \
    rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM gcr.io/distroless/cc-debian12
WORKDIR /app
COPY --from=builder /app/target/release/atlas-orbit /app/atlas-orbit
ENV PORT=8080
EXPOSE 8080
CMD ["/app/atlas-orbit"]
