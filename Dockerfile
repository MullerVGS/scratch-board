FROM node:22-alpine

WORKDIR /app
COPY src ./src
COPY shared ./shared
COPY public ./public

ENV PORT=7777
# O diretório comum das origens. Cada filho direto dele é um namespace completo, e quem os
# monta é o compose — não há lista de origens em env nem em arquivo de config.
ENV SCRATCHES_DIR=/workspace/scratches
EXPOSE 7777

CMD ["node", "src/server.js"]
