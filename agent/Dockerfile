FROM public.ecr.aws/docker/library/node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

RUN useradd -m -u 1001 bedrock_agentcore
USER bedrock_agentcore

ENV AWS_REGION=us-west-2
ENV VECTOR_BUCKET_NAME=party-supply-vectors

EXPOSE 8080 8000 9000
CMD ["node", "dist/agent.js"]
