# syntax=docker/dockerfile:1
# Resolved and recorded by the harness; no floating runtime image selection.
ARG NODE_IMAGE=node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
FROM ${NODE_IMAGE}
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca,required=true \
    NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --ignore-scripts --strict-ssl=true \
    && chmod -R a+rX /app
ARG SOURCE_SHA
RUN node tools/operator-publication/isolation/measure.mjs --write "$SOURCE_SHA" \
    && rm -f /bin/sh /bin/bash /bin/dash /usr/bin/sh /usr/bin/bash /usr/bin/dash
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node", "tools/operator-publication/isolation/entry.mjs"]
