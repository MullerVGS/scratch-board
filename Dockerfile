FROM node:22-alpine

WORKDIR /app
COPY src ./src
COPY shared ./shared
COPY public ./public

ENV PORT=7777
# O diretório comum das origens. Cada filho direto dele é **um repo montado**, e a origem é o
# `.scratch/` de dentro dele. Quem os monta é o compose — não há lista de origens em env nem
# em arquivo de config.
#
# `repos`, e não `scratches`: montar o `.scratch/` direto é o bug do inode preso (ver o
# `paths.js`), e um nome que diga "scratches" convida a fazer exatamente isso de novo.
ENV REPOS_DIR=/workspace/repos
EXPOSE 7777

CMD ["node", "src/server.js"]
