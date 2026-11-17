# Nightly backups (docker-compose.yml, service "backup"): PostgreSQL's own tools, plus age to encrypt the copies that
# leave the server (https://age-encryption.org).
FROM postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139
RUN apk add --no-cache age
