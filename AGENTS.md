# AGENTS.md — scratch-board

Visualizador **read-only** dos `.scratch/` do workspace: uma árvore de arquivos por data à esquerda, e à direita ou o arquivo aberto (renderizado, ao vivo) ou o grafo da pasta selecionada. Multi-projeto por abas. Serve para **ver o que a IA está fazendo** — os arquivos que ela gera —, sem exigir formato nenhum.

Ele não rastreia tickets: não há kanban, Gantt, catálogo de história, "tempo em coluna" nem comando de skill. Um esforço não precisa ser uma pasta com `PRD.md`/`map.md`/issues; qualquer arquivo entra na árvore. O que sobrou de estrutura é **oportunista** — se um `.md` tem uma linha `Status:`, ela vira um selo; se não tem, não falta nada.

## O princípio

**Os `.md` são a fonte da verdade. O board os projeta e nunca escreve.** Nenhuma rota escreve num arquivo, e todo `.scratch/` sobe **read-only**: a garantia é do mount, não da boa intenção. Existe cache, e ele é **derivado** — um watcher relê o disco e o reconstrói; nenhuma rota o serve no lugar do disco. Ele existe para **suprimir** o que não mudou, nunca para *responder*.

## As origens e o mount

O board tem **as origens que estiverem montadas**, cada uma um `.scratch/` completo. `projetos` é a de casa; qualquer outra pasta é a próxima. **O compose é a configuração inteira:**

```yaml
- ../:/workspace/repos/projetos:ro
- ../vend-server:/workspace/repos/vend-server:ro
```

Cada filho direto de `/workspace/repos/` é um **repo**, a origem é o `.scratch/` **de dentro dele**, e o nome da pasta é o nome da origem. Um `readdir` no `start()` descobre tudo — sem env, sem lista, sem registro no código. Mount novo, aba nova, container recriado (`--force-recreate`).

### Monte o repo, nunca o `.scratch/`

A linha que alguém vai "simplificar" de volta, porque montar o `.scratch/` direto parece mais honesto. Era assim, e **matava o board em silêncio.** Um bind mount se prende ao **inode**; o `.scratch/` é versionado, e um `git checkout` para uma branch que não o contém **apaga o diretório** (no `vend-server`, `main` não o tem) e o recria com **outro inode**. Montado o `.scratch/`, o container ficava preso ao inode morto e via a origem **vazia para sempre** — um repo cheio de esforços aparecendo como um repo sem nenhum, a mentira mais cara que este board pode contar. Nem a varredura nem o botão de reler curavam; só `--force-recreate`.

O diretório do **repo** o git nunca apaga: montado ele, o `.scratch/` é resolvido **por caminho** a cada `readdir`, e o inode novo é achado sozinho. Consequências:

- **Montar o repo não é servir o repo.** O `safePath()` prende as leituras ao `ns.root` (o `.scratch/` de dentro); nenhum byte fora dele fica alcançável.
- **A origem existe porque o repo está montado**, não porque o `.scratch/` está lá agora. Um repo cuja branch atual não o tem é uma origem de board **vazio** — e vazio é a verdade.
- **O nome é um segmento só, de primeiro nível.** `admin-server/administrative` a dois níveis não vira origem própria — desenha um board plausível e errado. Monte só repos de primeiro nível (ou um symlink que os aplaine).
- **A de casa vem primeira** (`HOME_NS`, default `projetos`); o resto em ordem alfabética. Um `#/` nu vai para a de casa.
- **O nome decide o `ref`** que o humano copia (abaixo): nomeie a pasta do mount como o caminho do repo a partir de `/root/projetos`.
- **Watcher, hash e varredura são por origem** (`createCache(ns)` é fábrica): sem isso, duas origens dividiriam o mesmo hash e a segunda a escrever seria **suprimida** pela primeira. Não há supressão cruzada.
- **Uma conexão SSE, N origens.** Cada evento carrega `ns` e **só o board daquela origem**; o cliente guarda sempre, redesenha só se for a aba na tela. Trocar de aba não faz request de board — ele já está na mão (medido: **0 request** de `/api/board` ao trocar; o grafo da pasta-raiz é buscado sob demanda). O snapshot de conexão manda todas as origens, uma por frame.
- **Vazia e quebrada são estados diferentes.** Um `.scratch/` sem arquivo mostra o vazio; uma origem que o disco recusou mostra o erro em vermelho e a aba troca a contagem por `!` (`errorTree()`). A falha fica contida na origem.

## O que o servidor projeta

Uma **árvore genérica** por raiz (`src/tree.js`, `buildTree(ns)` = "leia o disco agora"): entradas pasta/arquivo ordenadas por `mtime` **decrescente** — o recente sobe, e uma pasta herda o `mtime` **máximo** do conteúdo recursivo, então a pasta onde a IA escreve vai ao topo. De cada `.md`, de forma **oportunista** e só se presente, extrai `Status:` (selo) e `# Título` (rótulo). Nenhum é obrigatório; um `.txt`, `.json` ou log entra igual, sem selo.

Contrato (`GET /api/board?ns=`, e o payload do evento SSE `message`):

```
{ ns, root, ref, error, tree: Node[] }
Node dir:  { type:'dir',  name, path, ref, rel, mtime, children }
Node file: { type:'file', name, path, ref, rel, mtime, status?, title? }
```

**Três vocabulários de caminho:** `path` = caminho no container (`/workspace/repos/<ns>/.scratch/...`), por onde o board **lê**; `ref` = caminho do workspace (`.scratch/...` na de casa, `<ns>/.scratch/...` nas outras), o que o humano **copia**; `rel` = caminho relativo à raiz da origem (`pos-x/map.md`), a **chave de rota** (`#/<ns>/<rel>`). O `ref` é derivado no servidor (`refIn`, `src/paths.js`); o `path` do container **nunca** aparece na tela nem no hash. O `ref` de topo vem no board para o nó-raiz sintético.

`mtime` = ms absoluto, e **entra no hash**: um save reordena a árvore → push legítimo; ocioso não tem save → zero push. O relativo (`"há 2h"`) é calculado **no navegador** (re-render local a cada 60s, sem rede) — nada de tempo relativo no payload, que envelheceria sozinho e empurraria o board parado.

## O grafo, por pasta

Selecionar uma pasta desenha um grafo escopado à **subárvore** dela (`GET /api/graph?ns=&path=`, `folderGraph()`, sob demanda). O modo é por presença de padrão:

- **`deps`** — se **algum `.md` da subárvore tem `Blocked by:`**: DAG de dependências, nós = arquivos-issue numerados, arestas = `Blocked by:`, layout por profundidade (camada 0 = frontier). O número resolve **só entre irmãos de mesma pasta-pai**.
- **`links`** — senão: nós = os `.md` da subárvore, arestas = links markdown relativos, resolvidos por caminho real (podem cruzar subpastas).
- **Sem aresta nenhuma** → nós soltos com uma nota, nunca um desenho fingido. Pasta sem `.md` → estado vazio.

```
{ mode:'deps'|'links', nodes: GNode[], edges: GEdge[] }
GNode: { id, name, title?, status?, path, ref, rel }   // id = path; rel = chave de rota
GEdge: { from, to, note? }                              // deps: note = prosa do Blocked by
```

O selo colore o nó; a issue fechada fica esmaecida (explica o que soltou a frontier). **Layout puro** (`public/graph-layout.js`), **desenho DOM** (`public/graph.js`, `public/edges.js`): os nós são HTML posicionado (chip, foco, clique que abre o arquivo no viewer via `#/<ns>/<rel>`), o SVG só desenha as curvas (`svg()`, nunca `el()` — um `<marker>` montado como HTML some sem erro). Invariantes travados em `test/graph-layout.test.js`: a camada é o **maior** caminho (nenhuma aresta anda para trás), ciclo não estoura (a aresta de volta é descartada), a ordem é o baricentro, e um guarda proíbe o módulo puro de tocar o DOM. O grafo nunca cruza projetos.

## Atualização ao vivo

O caso de uso central — *ver a IA escrevendo*. Duas preocupações independentes, com **duas supressões que não se colapsam**:

- **A árvore mudou** (arquivo nasceu, sumiu, ou o `mtime` reordenou): o servidor remonta a projeção, hasheia (sha1) e **só empurra por SSE se o hash mudou**. Toque, `.swp`, reescrita byte-idêntica não empurram. Evento `message` = `{ ns, board, changed }`.
- **O arquivo aberto mudou** por baixo do leitor: o conteúdo é trocado **preservando a rolagem** (`scrollTop`), com um realce (`flash`), e o estado âmbar de "arquivo sumiu" (404). Evento `files` = `{ ns, changed }` — o caso estreito de conteúdo reescrito com o `mtime` **preservado** (a árvore não mudou).

Como o `mtime` está no hash, o **save normal chega por `message`** — logo o `changed` (os caminhos que o digest viu mudar) é a fonte da verdade de "o que mudou", e viaja nos dois eventos. O viewer relê o arquivo aberto se o `path` dele está em `changed`, em qualquer dos dois. **`changed: []` = "não sei o que mudou"** (o snapshot de conexão) → relê no escuro e deixa a supressão por conteúdo (`shown`) decidir; acreditar no silêncio é a doença que o board existe para curar.

**Por que dois eventos** (`src/watch.js` → `src/cache.js` → `sync()` em `src/server.js`): o `fs.watch` fala de *escrita*, não de *conteúdo* — um `.md` reescrito com bytes idênticos, um `touch`, um `.swp` que nasce e morre são movimento no disco. Todo caminho passa pelo **digest** (`movedFiles()`, carimbo `size:mtime` como portão barato + sha1 do conteúdo) antes de virar evento. E o `fs.watch` recursivo do Node **para de reportar um nome depois de um `rename`** (o `.md.tmp.NNNN` + `rename` que todo agente usa): o watcher é **gatilho** (o `.tmp` é nome novo, o kernel sempre o conta), o digest é **testemunha**. **Ocioso não varre; ocioso custa zero.**

## A rede de segurança

**O modo de falha de um push é o silêncio, indistinguível de "nada mudou".** Três defesas, todas no código:

- **Varredura de 90s** (`SWEEP_MS`, `src/server.js`): um `setInterval` que chama o `sync()` de cada origem — relê, compara, suprime. Quase de graça por causa da supressão; na maioria das voltas, zero byte no fio. Devolve a única propriedade que o polling tinha de graça: **não conseguir ficar em silêncio mentiroso por mais de 90s.**
- **Indicador de conexão** (`.dot`, `public/shell.js`): a única coisa na tela capaz de dizer *não sei*.

  | estado | cor | o que diz |
  | --- | --- | --- |
  | `live` | verde | o board chega sozinho |
  | `retry` | âmbar pulsando | reconectando |
  | `dead` | vermelho, halo apagado | sem conexão — o que você vê pode estar velho |

  A contagem até o vermelho corre desde o último `open` (não desde o último erro, senão o âmbar seria eterno); uma vez vermelho, só o `onopen` o traz de volta.
- **Botão de reler** (`⟳`): a válvula humana; bate no `/api/board`, que **relê o disco** por dentro do `sync()`.

O `EventSource` reconecta sozinho, e o snapshot manda o board inteiro relido — restart de container se cura sem F5. E o **`rearm()`** (no `sync()`): quando o `git checkout` recria o `.scratch/` com outro inode, o `fs.watch` fica preso ao inode morto **sem emitir `error`** (cala, parecendo vivo) — um `stat` no root detecta a troca do inode e reabre o watch. É heurística com a varredura embaixo (o ext4 pode reusar o número); degrada, nunca mente.

## O parser existe uma vez: `shared/parse.js`

`parseDoc()`, `normalizeStatus()`, `KNOWN`, `parseBlockedBy()`/`splitBlockedBy()`, `relLinks()` — um arquivo só, importado pelo servidor **e** pelo browser (servido em `/shared/`). É **puro** (`string → objeto`) e **não pode tocar `node:` nem o DOM**. Já existiu duplicado (uma cópia no servidor, outra no cliente), e as cópias divergiram — o servidor era a errada.

- **Três dialetos de cabeçalho.** As chaves `Chave: valor` podem vir **antes** do `# Título` (wayfinder) ou **depois** (issue tracker). `parseDoc()` varre o **preâmbulo inteiro** (até o primeiro `## `) e só aceita as chaves de `HEADER_KEYS`, para que prosa com dois-pontos não vire estado. Há `Status:` em corpo de issue; a fronteira do `## ` é o que o barra.
- **`Blocked by:` traz prosa.** Na prática: `01 (resolvido), 08 — a revisão achou defeito…`. Só o número que **abre** cada fragmento separado por vírgula é referência; o resto é a justificativa. `parseBlockedBy()` quebra em `{ number, note }`; um fragmento sem número que o abra não vira aresta.

## Vocabulário de status

Canônicos (`docs/agents/triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Do wayfinder: `open`, `claimed`, `resolved`. Na prática: `done`, `partial`. Um status fora da lista é exibido com **`?` e em vermelho** — vocabulário novo deve **aparecer**, não sumir num balde de "outros". O selo é montado num só lugar (`statusChip()`, `public/dom.js`), consumido pela árvore e pelo grafo.

## Os módulos

Servidor (`src/`), um assunto por arquivo:

| Módulo | Assunto |
| --- | --- |
| `src/tree.js` | Monta a projeção de **uma origem**. `buildTree(ns)` = "leia o disco agora", **sem cache dentro**; `errorTree()` para a origem que não deu para ler. |
| `src/paths.js` | `discover()` das origens e a tradução `path`/`ref` (`refIn`). Existe à parte para não ciclar com o `server.js`. |
| `src/watch.js` | O disco falando: `fs.watch` recursivo, debounce, reopen no `error`. **Só emite.** Um por origem. |
| `src/cache.js` | A supressão, por origem (`createCache(ns)`): o hash do board (`refresh()`) e o digest por arquivo (`movedFiles()`, `seed()`). |
| `src/server.js` | Só HTTP: rotas, estáticos, SSE, `safePath()`, `folderGraph()`, `sync(ns)`, `rearm()` e a varredura. |

Cliente (`public/`), o `index.html` aponta para um único `<script type="module" src="/app.js">`:

| Módulo | Assunto |
| --- | --- |
| `app.js` | O fio + o **controlador do painel direito**: acha o nó da rota e chama `showFolder` (pasta) ou `showFile` (arquivo). |
| `router.js` | O hash decide origem e alvo (`#/<ns>/<rel>`); o `EventSource` (`connect()`). |
| `shell.js` | A moldura: abas de origem, `.dot` de conexão, botão de reler; `#pane-left`/`#pane-right`. |
| `state.js` | Os boards na mão do cliente — um por origem, num contêiner mutável. |
| `tree.js` | A árvore (painel esquerdo): pastas expansíveis, selo, cópia, seleção — expansão e rolagem sobrevivem ao push. |
| `viewer.js` | O painel direito **fixo** de um arquivo: render por tipo, a troca ao vivo (rolagem preservada), o sumiço âmbar, e os links do renderer com trilha de volta (`←`/`Esc`). |
| `md.js` | O renderer do dialeto `.scratch` (importa `shared/parse.js`): cabeçalho, `Blocked by:`→link, caminho→copiável, link relativo→navegação. |
| `graph.js` / `graph-layout.js` / `edges.js` | O grafo da pasta: desenho DOM, layout puro, a maquinaria de setas em SVG. |
| `dom.js` | `el()`, `svg()`, `esc()`, `api()`, `toast()`, `copy()`, `copyBtn()`, `pressable()`, `statusChip()`. |

Os três diretórios (`src/`, `shared/`, `public/`) são montados **como diretório**, nunca arquivo a arquivo: módulo novo passa a valer sem tocar em `docker-compose.yml`/`Dockerfile`. `shared/` é servido pela HTTP (`/shared/`) — se essa rota cair, o board morre no import e nenhum teste de unidade percebe; por isso há um teste HTTP que a cobre.

## Copiar, e a rolagem

Nome e caminho de qualquer arquivo são copiáveis com um clique (`copyBtn()`, `public/dom.js`): o botão fica sempre no DOM (invisível por opacidade até hover/foco, para o teclado alcançá-lo; sempre visível em touch), confirma no próprio ícone (✓), e para o clique no próprio botão (`stopPropagation` — copiar não é navegar). Copia-se **o que se lê** — o texto na tela é o texto no clipboard.

As duas colunas rolam **cada uma por si**: a shell tem altura contida na viewport (`height:100vh`), e `#pane-left`/`#pane-right` têm `overflow` próprio. É o que torna a preservação de rolagem do viewer coerente — quem rola é sempre o painel, e a troca ao vivo repõe o `scrollTop` dele.

## Stack, rodar, testes

Node 22, **zero dependências**, frontend vanilla sem bundler. `node:http`/`node:fs`/`node:crypto`/`fs.watch`/`node:test` são builtin; SSE é `text/event-stream` + `res.write`, `EventSource` é nativo. O `listen` fica atrás de um guard de módulo principal (`resolve(process.argv[1]) === import.meta.filename`), senão o `import` do teste levantaria a porta e penduraria o `node --test`.

```
docker compose up -d      # http://localhost:7777
node --test test/         # 123 testes, zero dependências
```

`src/`/`shared/`/`public/` são volume, sem build step — editar e `docker compose restart` basta. **Mexer nas origens é a exceção**: descobertas no `start()`, pedem `--force-recreate`.

Testes — as costuras caem onde o código é puro ou onde ele fala HTTP (não há `jsdom`):

| Costura | O que trava |
| --- | --- |
| `test/parse.test.js` | O parser: os três dialetos, o `Status:` de corpo que não vira estado, o `Blocked by:` com prosa, o desconhecido virando `?`. |
| `test/md.test.js` | O renderer: a ordem das transformações e o `Blocked by:` que linka sem engolir a justificativa. |
| `test/tree.test.js` | A árvore: ordenação por data, pasta herdando a recência do conteúdo, arquivo genérico sem selo, selo oportunista, o `ref` de topo sem vazar `/workspace/`. |
| `test/graph-layout.test.js` | Os invariantes do grafo (puros): camada = maior caminho, nenhuma aresta para trás, ciclo que não estoura, baricentro, e o guarda de pureza. |
| `test/server.test.js` | A costura mais alta: servidor real em porta efêmera, SSE lido com `fetch`, escritas de verdade — o push, o debounce, a supressão, o arquivo novo sem restart, o caminho fora do root recusado, os dois eventos, a segunda escrita atômica (o caso que o watcher derrubaria), e a troca ao vivo do arquivo aberto. |
| `test/watch.test.js` | O reopen depois do `error`, e um root que ainda não existe. |
| `test/sweep.test.js` | A varredura de segurança com relógio curto — arquivo separado para não envenenar as asserções de silêncio do `server.test.js`. |
| `test/checkout.test.js` | O contrato do layout: a origem é o `.scratch/` dentro do repo, uma branch sem ele é board vazio (não erro), o root resolvido por caminho. |
| `test/namespaces.test.js` | O que só existe com N origens: descoberta e ordem, `ref` nu × qualificado, dois slugs iguais que não se confundem, o push que carrega só o board da sua origem, a supressão que não atravessa, vazia × quebrada, o snapshot uma origem por frame. |
| `test/viewer.test.js` | O que o viewer assume: o `changed` no mesmo vocabulário de caminho do board, a string do 404, e o nó de arquivo que ele recebe. |

Fora de teste, deliberadamente: DOM, CSS, interação do viewer, arrasto do grafo — verificados **dirigindo o app de verdade** (chromium por CDP), não com um DOM falso.

## Fronteira

O board mecaniza o que é determinístico — ler o disco, projetar a árvore, renderizar o documento. O que exige julgamento é das skills, e **muda os `.md`**. O board não muda `.md`: ele lê, e só.
