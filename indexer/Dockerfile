FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js warroom-event.schema.json ./
EXPOSE 9400
CMD ["node", "server.js"]
