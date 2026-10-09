FROM node:22-slim
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev && npm i tsx
COPY server server
COPY web web
WORKDIR /app/server
ENV PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
