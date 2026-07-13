FROM node:22-alpine

WORKDIR /app
COPY src ./src
COPY shared ./shared
COPY public ./public

ENV PORT=7777
ENV SCRATCH_DIR=/workspace/.scratch
EXPOSE 7777

CMD ["node", "src/server.js"]
