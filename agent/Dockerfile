FROM public.ecr.aws/docker/library/node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
# tsconfig.json may be excluded by agentcore CLI, create inline if missing
RUN if [ ! -f tsconfig.json ]; then \
  echo '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","outDir":"./dist","rootDir":".","strict":true,"esModuleInterop":true,"skipLibCheck":true,"declaration":true,"resolveJsonModule":true},"include":["*.ts","tools/**/*.ts"],"exclude":["node_modules","dist"]}' > tsconfig.json; \
fi
RUN node node_modules/typescript/bin/tsc

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
