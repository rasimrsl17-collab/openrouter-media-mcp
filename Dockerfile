FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# media files + quota/job state live here; mount a volume
RUN mkdir -p /data/media /data/state && chown -R node:node /data
VOLUME ["/data"]

USER node
ENV PORT=3400 MEDIA_DIR=/data/media STATE_DIR=/data/state
EXPOSE 3400

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3400)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
