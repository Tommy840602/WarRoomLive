FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# No dependencies on purpose: node's own http server is the whole service, and a
# dev fixture that needed an npm install would be one more thing to go wrong
# before the stack comes up.
COPY package.json ./
COPY server.js ./
EXPOSE 8090
CMD ["node", "server.js"]
