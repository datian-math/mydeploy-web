FROM node:22-slim

# 安装 tectonic（轻量 LaTeX 引擎，约 50MB）
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates \
    && wget -q https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz \
    && tar xzf tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz -C /usr/local/bin/ tectonic \
    && chmod +x /usr/local/bin/tectonic \
    && rm tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制并安装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制代码
COPY server.cjs ./
COPY data/ ./data/
COPY uploads/ ./uploads/

# 创建临时目录
RUN mkdir -p data/pdf_exports data/auto-save

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server.cjs"]
