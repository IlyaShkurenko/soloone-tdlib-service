FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY tdlib-service/package*.json ./tdlib-service/
COPY api/package*.json ./api/
COPY web/package*.json ./web/

RUN npm install --workspace tdlib-service --include-workspace-root=false

COPY . .

EXPOSE 4002

CMD ["npm", "run", "dev", "--workspace", "tdlib-service"]
