FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY src/ ./src/
COPY pages/ ./pages/
COPY .env ./.env

EXPOSE 30001

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
