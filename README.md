# scratch-board

Visualizador **read-only** dos diretórios `.scratch/` dos seus repositórios — uma forma simples de **ver o que a IA está fazendo**: os arquivos que ela gera, ordenados por data, sem exigir formato nenhum.

Duas colunas. À esquerda, uma **árvore de arquivos** por `mtime` decrescente — a pasta onde a IA está escrevendo sobe ao topo. À direita, ou o **arquivo aberto** (`.md` renderizado, o resto monoespaçado e literal) ou o **grafo da pasta** selecionada. Cada arquivo é copiável (nome e caminho, um clique).

- **Multi-projeto por abas**: cada `.scratch/` montado é uma origem completa e isolada. Dois esforços de mesmo nome em repositórios diferentes são dois esforços.
- **Grafo por pasta**: dependências (`Blocked by:`) quando o padrão existir; senão, os links markdown entre os arquivos; sem aresta, os nós soltos com uma nota — nunca um desenho fingido.
- **Status é um selo oportunista**: se um `.md` tem uma linha `Status:`, ela vira um selo colorido (`?` em vermelho para o desconhecido). Nunca é obrigatório.
- **Ao vivo**: quando a IA escreve o arquivo que você está lendo, o conteúdo troca sozinho, **preservando a rolagem**. A árvore reordena quando o disco muda. Ocioso custa zero.

Não há kanban, Gantt, catálogo de história, "tempo em coluna", scratchpads nem comando de skill. Um esforço **não precisa** ser uma pasta com `PRD.md`/`map.md`/issues — qualquer arquivo entra na árvore.

## As origens

O board tem os `.scratch/` que estiverem montados sob um diretório comum, e **o compose é a configuração inteira**:

```yaml
- ../:/workspace/repos/projetos:ro
- ../vend-server:/workspace/repos/vend-server:ro
```

Cada filho direto é um **repo**, a origem é o `.scratch/` **de dentro dele**, e o nome da pasta é o nome dela. Um mount novo vira uma aba nova no próximo start — sem env, sem arquivo de config.

**Monta-se o repo, e não o `.scratch/`** — a diferença importa. O `.scratch/` é versionado, e um `git checkout` para uma branch que não o tem apaga o diretório e o recria com outro inode; como um bind mount se prende ao inode, montá-lo direto deixava a origem **vazia para sempre**. Montado o repo, o `.scratch/` de dentro é reencontrado por caminho a cada leitura. O caminho interno do container nunca aparece na tela.

## Os `.md` são a fonte da verdade

Não há banco nem índice, e o board **não escreve** — nem um byte. Quem muda status é você, ou a skill, no arquivo. Todo `.scratch/` sobe montado **read-only** para que isso seja garantia, não promessa.

E o board não pergunta ao disco: ele **é avisado**. Um `fs.watch` vê o arquivo tocar o disco, o servidor remonta a projeção e empurra por SSE — **só se ela mudou de verdade**. Sem polling, sem refresh. Um push pode falhar em silêncio, então há rede: uma varredura de segurança de 90s, um indicador de conexão que admite quando não sabe, e um botão de reler.

## Rodar

```
docker compose up -d      # http://localhost:7777
node --test test/         # 123 testes, zero dependências
```

Node 22, **zero dependências**, frontend vanilla sem bundler. `src/`/`shared/`/`public/` são volume, sem build step — editar e `docker compose restart` basta; mexer nas origens pede `--force-recreate`.
