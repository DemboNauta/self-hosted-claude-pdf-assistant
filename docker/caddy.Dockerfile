# syntax=docker/dockerfile:1
# Optional reverse proxy with automatic HTTPS (compose profile "caddy").
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
