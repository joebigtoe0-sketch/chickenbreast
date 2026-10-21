# Works on Fly, Render, Koyeb, Northflank, Railway, or plain Docker on a VPS.
FROM node:20-alpine

WORKDIR /app

# deps first, so a code change does not re-install the SDKs every build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# NODE_ENV is what tells config.js to bind 0.0.0.0 and honour the injected PORT
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# data/ is a mounted volume in production: the contract address, the position
# book and the holders history live there and must survive a redeploy
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
