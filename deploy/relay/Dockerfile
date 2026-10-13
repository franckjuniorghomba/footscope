FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2
WORKDIR /app
COPY --chown=node:node scripts/relay.mjs ./relay.mjs
USER node
EXPOSE 8787
CMD ["node", "relay.mjs"]
