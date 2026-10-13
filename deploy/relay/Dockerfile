FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node scripts/relay.mjs ./relay.mjs
USER node
EXPOSE 8787
CMD ["node", "relay.mjs"]
