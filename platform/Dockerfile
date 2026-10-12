FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
COPY public ./public
# Encrypted licence documents live on a volume owned by the app user.
RUN mkdir -p /data/documents && chown node:node /data/documents
ENV DOCUMENT_DIR=/data/documents
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]
