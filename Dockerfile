FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY shared ./shared
COPY public ./public

ENV PORT=7777
ENV SCRATCH_DIR=/workspace/.scratch
EXPOSE 7777

CMD ["node", "server.js"]
