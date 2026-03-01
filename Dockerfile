FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.ts ./
COPY public ./public

EXPOSE 8080

CMD ["node", "--experimental-strip-types", "server.ts"]
