# Build context is the repository root.
FROM caddy:2.11.9-alpine

COPY apps/gateway/Caddyfile /etc/caddy/Caddyfile
COPY apps/gateway/snippets /etc/caddy/snippets

# Fail the build on a config error instead of at deploy time.
RUN PUBLIC_HOST=example.test \
    RELAY_UPSTREAM=127.0.0.1:3000 \
    PAIRING_UPSTREAM=127.0.0.1:5000 \
    ADMIN_UPSTREAM=127.0.0.1:8787 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Port 8080 needs no privileges, and nothing is written to disk.
USER 65532:65532
ENV XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data

EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
