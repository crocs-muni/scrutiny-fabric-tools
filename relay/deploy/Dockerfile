# syntax=docker/dockerfile:1
#
# scrutiny-fabric relay image.
#
# BUILD CONTEXT IS THE RELAY MODULE ROOT (`relay/`), not this directory:
#     docker build -f deploy/Dockerfile .        # run from relay/
# deploy/compose.yaml encodes this as `build.context: ..` (i.e. the relay/
# module root resolved from the deploy/ directory). Building with context
# `deploy/` fails because go.mod and the source tree are one level up.
# The in-context COPY paths below (go.mod, go.sum, ., ./cmd/relay) are all
# relative to the relay/ module root and require this context.

# ---------- build stage ----------
# Replace with a digest pin (golang:1.26-bookworm@sha256:...) when this goes to a registry.
FROM golang:1.26-bookworm AS build
WORKDIR /src

# Layer-cache the module download: this layer only invalidates when go.mod or
# go.sum changes. The pinned dependency set lives entirely in those two files.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# The whole stack is pure Go (bbolt + bleve + lingua), so CGO is never needed;
# a static binary is what lets us run on distroless/static.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags='-s -w' -o /out/relay ./cmd/relay

# Pre-create the data directory owned by the distroless nonroot uid (65532).
# A fresh named volume mounted at /data inherits this ownership on first use,
# so the relay can write base.bolt and the bleve index without running as root.
RUN mkdir -p /out/data && touch /out/data/.keep && chown -R 65532:65532 /out/data

# ---------- runtime stage ----------
# static-debian12 carries CA certificates (needed by nothing at runtime today,
# but harmless) and a nonroot user; `:nonroot` sets USER to 65532.
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /data
COPY --from=build --chown=65532:65532 /out/relay /relay
COPY --from=build --chown=65532:65532 /out/data/ /data/
EXPOSE 3334
ENV SCRUTINY_LISTEN_ADDR=0.0.0.0:3334 \
    SCRUTINY_DATA_DIR=/data
ENTRYPOINT ["/relay"]
