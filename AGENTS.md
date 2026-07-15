# AGENTS.md — scratch-board

Board de leitura dos `.scratch/` do workspace. Serve para enxergar os esforços em curso, lembrar do que cada um se trata, ler os documentos e sair com o comando que destrava o próximo passo.

## O princípio

**Os `.md` são a fonte da verdade. O board é uma projeção — e só isso.**

O board **não escreve**. Quem muda status é você ou a skill que resolve o ticket, no arquivo; o board **é avisado** e mostra o resultado — sem refresh, sem F5, sem esperar relógio nenhum. Não há banco e não há índice.

Existe **cache**, e ele não fere o princípio — mas a distinção é fina o bastante para merecer estar escrita, porque é ela que alguém vai atropelar. O cache do `src/cache.js` é **derivado**: um watcher relê o disco e o reconstrói inteiro a partir dos `.md`. Ele não é um estado paralelo que alguém edita, ninguém escreve nele pela lateral, e **nenhuma rota o serve no lugar do disco** — nem o `/api/board`, nem o snapshot de conexão do SSE. Ele existe para **suprimir** o que não mudou, nunca para *responder*. Um board de memória servido sem reler é exatamente o silêncio mentiroso que o push corre o risco de virar (ver **A rede de segurança**).

Houve um kanban com drag-and-drop que gravava `Status:` ao soltar o card. Saiu. Ele nasceu de uma palavra solta na especificação ("kanban"), não de uma necessidade — e ser a única superfície de escrita punha o board em contradição com a própria fronteira que ele defende (ver **Fronteira**, no fim). O `.scratch/` sobe montado **read-only**: a garantia agora é do mount, não da boa intenção.

Se for adicionar recurso, mantenha a propriedade: **nada de estado que não esteja nos `.md`, e nada de escrita.** A única exceção é a largura da gaveta (ver **A gaveta**), que é preferência de quem olha, não conteúdo.

## As origens

O board não tem *um* `.scratch/`. Ele tem **os que estiverem montados**, cada um uma **origem** (namespace) completa: esforços, mapas, issues, archive, kanban, grafo, gaveta, comandos e push. `projetos` é a de casa; `vend-server` é a segunda; qualquer subpasta nova é a próxima.

**O compose é a configuração, e é a única.** Cada filho direto de `/workspace/scratches/` é uma origem, e **o nome da pasta é o nome dela**:

```yaml
- ../.scratch:/workspace/scratches/projetos:ro
- ../vend-server/.scratch:/workspace/scratches/vend-server:ro
```

Não há lista em env, não há arquivo de config, não há registro no código. Uma segunda lista seria uma segunda fonte da verdade, e as duas divergiriam no dia em que alguém somasse o mount e esquecesse a lista — o board subiria mostrando um repositório a menos, **sem erro nenhum**. A descoberta é um `readdir` no `start()`: mount novo, aba nova, container recriado.

As decisões que caem daí, e o que cada uma protege:

- **A de casa vem primeira; o resto, em ordem alfabética.** `HOME_NS` (default `projetos`) é quem decide qual é a de casa, e ela é a entrada inicial: um `#/` nu vai para ela.
- **O nome da origem decide o `ref`.** Os comandos partem de `/root/projetos`, então a de casa produz `.scratch/...` — nu, porque o agente já está lá — e qualquer outra produz `<nome>/.scratch/...`. **Nomeie a pasta do mount como o caminho do repo a partir de `/root/projetos`**, ou o comando copiado apontará para um lugar que não existe. O caminho do container nunca aparece na tela.
- **O nome é um segmento só, e um repo aninhado ainda não tem como entrar.** `admin-server/administrative` está a dois níveis de `/root/projetos`, e um mount em `/workspace/scratches/admin-server/administrative` **não** cria uma origem chamada `admin-server/administrative`: ele cria um filho direto chamado `admin-server`, e o board o lê como uma origem cujo único "esforço" se chama `administrative`. Não estoura nada — **desenha um board plausível e errado**, que é o pior jeito de falhar. Enquanto isso não for resolvido (o `ref` teria que sair de outro lugar que não o nome da pasta), **monte só repos de primeiro nível**.
- **Toda rota é qualificada, e não há rota legada.** `#/<ns>`, `#/<ns>/<slug>`, `#/<ns>/<slug>/grafo`, `#/<ns>/<slug>/gantt`, `#/<ns>/archive/<slug>`. O slug sozinho não endereça nada: **dois esforços com o mesmo slug em origens diferentes existem**, e um hash sem origem escolheria um dos dois no escuro. Um `#/<slug>` velho cai na origem de casa em vez de meio funcionar.
- **Watcher, hash do board, digest dos arquivos e varredura são por origem.** O `cache.js` é uma **fábrica** (`createCache(ns)`) por isso: com o estado no módulo, duas origens dividiriam o mesmo hash, e a segunda a escrever teria a sua mudança **suprimida** pela primeira — o board de um repositório simplesmente parando de chegar, que é indistinguível de "nada mudou". Não há supressão cruzada, e não é uma regra a lembrar: é a forma da função.
- **Uma conexão SSE, N origens.** Cada evento carrega `ns` e **só o board daquela origem** — mandar as N em todo evento seria pagar o board do `vend-server` toda vez que alguém escreve no `projetos`. O cliente guarda o board novo sempre; **redesenha só se a origem for a que está na tela**. Uma origem inativa que andou atualiza a contagem da própria aba e nada mais se mexe (medido: **0 re-render** da origem ativa, e a aba do `projetos` subindo de 58 para 59 enquanto o `vend-server` estava aberto). Trocar de aba não faz request: o board já está na mão.
- **O snapshot de conexão manda todas as origens, uma por frame.** Quem reconecta não sabe quanto tempo ficou fora, e a origem que não está na tela também pode ter andado.
- **Vazia e quebrada são estados diferentes, e o board diz qual é qual.** Um `.scratch/` recém-montado sem esforço nenhum mostra o estado vazio; uma origem que o disco recusou mostra **o erro, em vermelho**, e a aba dela troca a contagem por um `!`. Servir uma lista vazia no lugar do erro seria a mentira mais cara que este board pode contar: um repositório cheio de esforços aparecendo como um repositório sem nenhum. A falha fica **contida** na origem que a sofreu (`errorBoard()`, em `board.js`) — sem isso, um `readFile` que estoura num repo derruba a montagem de todos.
- **O `safePath()` apenas conhece mais roots.** Nenhuma política nova de `realpath`, nenhum endurecimento novo de symlink: o que mudou foi a lista, não o modelo. O diretório comum **não** é um root — ele contém as origens, mas não é uma delas.

## Rodar

```
docker compose up -d      # http://localhost:7777 (só loopback)
node --test test/         # 157 testes, zero dependências
```

`src/`, `shared/` e `public/` são montados como volume e não há build step — editar e `docker compose restart` basta. **Mexer nas origens é a exceção**: elas são descobertas no `start()`, então um mount novo pede `docker compose up -d --force-recreate`, não um restart.

## Stack

Node 22, **zero dependências**, frontend vanilla sem bundler. Não é minimalismo por esporte: sem `package.json` não há `npm install`, lockfile, nem árvore de dependência para manter numa ferramenta que existe para economizar seu tempo, não consumir.

A zero-dependência **sobreviveu ao push e aos testes**, e isso não foi sorte — foi escolha em cada peça. `node:http`, `node:fs`, `node:crypto`, `fs.watch`, `node:test` e `node:assert` são builtin. SSE é `content-type: text/event-stream` mais `res.write`, e o `EventSource` é nativo do browser. Não há `jsdom`, e não deve haver: as costuras de teste caem onde o código já é puro, ou onde ele fala HTTP (ver **Os testes**).

O `listen` do `src/server.js` fica atrás de um **guard de módulo principal** (`resolve(process.argv[1]) === import.meta.filename`). Ele não é sobra: sem ele, o `import` do teste levantaria a porta 7777 e penduraria o `node --test`. `node src/server.js` sobe o servidor como sempre; o teste importa `start(port)` e pede uma porta efêmera.

## O push: o board não pergunta, ele é avisado

O board **polava o disco a cada 5 segundos** e jogava a página fora para redesenhar a resposta, mesmo quando a resposta era "nada": 720 requests/hora/aba, 62 KB cada, ~63 mil leituras de `.md`/hora, e um re-render total a cada 5s. Isso morreu. Hoje: **1 request no primeiro load, mais uma conexão SSE longeva, zero leitura no ocioso, zero re-render no ocioso** — e uma mudança no disco aparece na tela em ~143ms medidos, em vez de até 5.000ms.

Três peças, e a divisão entre elas é a decisão:

- **`src/watch.js` — o disco falando.** `fs.watch` recursivo, com debounce de 120ms. **Só emite.** Não sabe o que é um board, um hash ou um assinante. Um `Write` só já dispara `rename` + `change`; um agente escrevendo seis arquivos de um esforço vira **uma** notificação, não seis. Tem handler de `error` que reabre o watch.
- **`src/cache.js` — a supressão.** Chama `buildBoard()`, serializa, hasheia (sha1) e compara com o último board que **saiu** daqui. **Byte-idêntico ⇒ ninguém é avisado.** Também é dele o digest por arquivo (`movedFiles()`, abaixo).
- **`src/server.js` — o fio.** A rota `/api/stream`, a lista de assinantes, e uma função `sync()` que é o **único caminho que emite**.

`buildBoard()` **não tem uma linha de cache dentro**, e isso é deliberado: o `board.js` sabe *como* montar a projeção, o cache decide *quando* montá-la e se alguém precisa saber. `buildBoard()` ser "leia o disco agora" é o que torna a supressão demonstrável em vez de prometida. Cache dentro do `board.js` fecharia as duas coisas num nó só — e é a "simplificação" que alguém vai propor.

`sync()` serve o watcher, a varredura **e** o `/api/board`. De propósito: uma releitura por HTTP que descobre uma mudança também avisa as outras abas, em vez de guardar a novidade para si e deixar o hash mentir para o resto do mundo.

### O evento carrega o board inteiro, não um diff

Um **diff** foi rejeitado, e não por preguiça: ele exigiria uma máquina de merge no cliente e uma de diff no servidor, e **as duas podem divergir do disco** — que é exatamente o pecado que o board existe para não cometer. Mandando o estado inteiro, calculado num lugar só, é **impossível o cliente derivar para um estado que o disco não tem**.

Um **tick** (`{version: 12}` seguido de um fetch) também saiu: custa um round-trip a mais e abre uma janela de corrida entre o anúncio e a busca.

As mudanças no `.scratch/` são raras e vêm de uma vez. 62 KB num evento raro é ordens de grandeza mais barato que 62 KB a cada 5 segundos para sempre.

### O `effort.mtime` saiu do payload

`readEffort` publicava `effort.mtime` (o `stat(dir).mtimeMs`). **Ele foi removido**, por dois motivos independentes:

- **Ninguém o lia.** Nenhuma view o usava. (O `ago()` dos pads usa o `mtime` dos *arquivos* de pad, que é outra coisa e permanece.)
- **Ele sabotaria a supressão.** O `mtime` de um *diretório* pula quando qualquer entrada nasce, morre ou é renomeada dentro dele — inclusive por arquivo temporário que o board nem projeta. No hash, ele moveria o hash sem o board mudar, e a supressão viraria decoração.

Um teste afirma que a string `mtime` não aparece em lugar nenhum do board serializado — e que o carimbo **não volta com outro nome** (publicá-lo como `at` mataria a supressão do mesmo jeito). **Campo instável no payload mata o push** — vale para qualquer campo novo.

Instável, note bem, e não *derivado do tempo*: o `held.at` da issue (o instante em que ela entrou na coluna atual) atravessa o fio e não fere nada, porque é um carimbo de **transição** — imóvel, dez salvamentos não o movem. Ver **"Em `<coluna>` há N"**.

### Dois eventos, e duas supressões independentes

**O board e o arquivo são duas coisas diferentes.** O board projeta `Status:`, título e `Blocked by:` — e **nada do corpo**. Um agente escrevendo a `## Answer` do ticket que você tem aberto na gaveta não move um pixel do *conteúdo* do board.

**Mas move a ordem, e ordem é board — uma vez.** Desde que os cards saem **por atividade** (ver **A ordem por atividade**), a primeira escrita num ticket que **não era o primeiro** da coluna o traz ao topo: o ranking muda, e essa mudança é um `message` legítimo, porque a tela de fato reordenou. Da segunda escrita em diante ele **já está em primeiro**, o ranking não se mexe, e os salvamentos seguintes voltam a ser `files` de ~126 bytes. Um push por ticket que esquenta, não um por salvamento — e é por isso que a ordenação foi barata.

Por isso o fio tem dois eventos, e o `sync()` tem duas supressões que **não podem ser colapsadas numa só**:

| evento | quando | o que carrega | quem decide |
| --- | --- | --- | --- |
| `message` | o **board** mudou | `ns` + o board daquela origem (+ `changed`) | o hash do board (`refresh()`) — autoriza **redesenhar a tela** |
| `files` | o **disco** mudou e o board não | `ns` + **só os caminhos** (~126 bytes) | o digest do conteúdo (`movedFiles()`) — autoriza **avisar quem lê** |

Os dois carregam `ns`, e **nenhum evento pode ser anônimo**: sem ele o cliente guardaria o board no lugar errado, e a tela mostraria os esforços de um repositório sob o nome de outro. O `changed`, porém, não precisa dele — o caminho é absoluto e já diz de que origem é, e a gaveta o compara direto com o que tem aberto (que pode ser de uma origem que não está na tela).

Colapsar as duas *era* o bug: enquanto o único sinal era o hash do board, a gaveta viva só funcionava nas bordas (quando o agente reivindicava e quando ele resolvia), e ficava cega enquanto ele escrevia o corpo. Medido: 126 bytes contra 71.917 do board — **571× menor**.

E emitir sem a segunda supressão reintroduz, pela porta dos fundos, o barulho que o push veio matar: **o `fs.watch` fala de escrita, não de conteúdo.** Reescrever um `.md` com bytes idênticos *é* uma escrita; um `touch` *é* um `change`; um `.swp` que nasce e morre *é* movimento no disco. Todo caminho que sai do watcher passa pelo digest antes de virar evento. **Byte-idêntico ⇒ zero byte no fio.**

### O watcher é gatilho, não testemunha

Esta é a decisão mais fácil de "simplificar" e quebrar em silêncio, e por isso ela vem com o defeito por escrito:

**O `fs.watch` recursivo do Node para de reportar um nome depois que um `rename` troca o inode por baixo dele.** E é exatamente assim que todo agente escreve — `.md.tmp.NNNN` + `rename` por cima. A **primeira** edição de um arquivo aparece na lista; da segunda em diante só o `.tmp` aparece, e o `.md` de verdade **some do relato do kernel**. (Medido e isolado: um watch **não-recursivo** no diretório continua reportando o nome para sempre. Se um dia o `watch.js` for reescrito, é por aí.)

Construída sobre essa lista, a gaveta viva funcionaria **uma vez por arquivo e depois calaria** — o pior modo de falha possível, porque *parece* funcionar.

Então: **o watcher diz *que* o disco mexeu; o digest diz *o quê*.** Para ser gatilho ele basta, porque o `.tmp` é sempre um nome novo e nome novo o kernel sempre conta. **A lista de caminhos do watcher não é fonte de verdade, e nada no board pode voltar a tratá-la como se fosse.**

`movedFiles()` varre o `.scratch/` e compara: o carimbo (`size:mtime`) é o portão barato — um `stat` diz que o arquivo *não* foi escrito, e aí não se lê nada —, e o **digest do conteúdo** é quem decide. Custo medido contra o `.scratch/` real (140 arquivos, 13 MB): **mediana de 12,3ms**, em paralelo com os 16,2ms da reconstrução do board. **Ocioso não varre**: nada disso roda por relógio.

Duas regras que caem daí:

- **No escuro, avisa-se.** Arquivo nunca visto e arquivo que sumiu contam como mudados. A assimetria é deliberada: um evento a mais custa algumas centenas de bytes e a gaveta o descarta; um evento a menos é **silêncio**, e silêncio é o modo de falha que este board inteiro existe para eliminar. (O `seed()` no `start()` é o outro lado disso: o disco de agora não é novidade, senão a primeira rajada empurraria os 140 caminhos.)
- **Caminho oculto não viaja.** O board nunca projeta entrada oculta, logo ela não pode estar aberta em gaveta nenhuma.

### A limitação que sobrou, e que o documento não vai esconder

O mesmo `rename` que cega o watcher para o nome cega-o também para as **escritas diretas seguintes** naquele arquivo (`echo >>`, `>` sem tmp). Nesse caso o gatilho **não dispara**, e quem repesca é a varredura de 90s — que hoje cura o board **e** a gaveta.

Na prática:

| escrita | a tela vê em |
| --- | --- |
| atômica (`tmp` + `rename` — agentes, editores) | **~150ms** |
| direta num arquivo já renomeado antes (`echo >>`) | **até 90s** |

Ninguém que escreve no `.scratch/` escreve assim, então o buraco é estreito e **tem rede embaixo**. Consertá-lo de verdade é reescrever o `watch.js` para watch por diretório em vez do recursivo do Node. Isso é uma limitação conhecida, não uma promessa quebrada — e **o `AGENTS.md` não promete o que o servidor não entrega**.

## A rede de segurança

**O modo de falha de um sistema de push é o silêncio — e silêncio é byte-a-byte indistinguível de "nada mudou".** Se o `fs.watch` morrer (limite de inotify, root remontado, um evento que o kernel simplesmente não entregou), o board mostraria dados velhos com cara de vivos, para sempre. Seria **pior** que o polling que ele substituiu, porque o polling era burro demais para conseguir mentir.

Três defesas, e as três estão no código:

- **Varredura de 90s** (`SWEEP_MS`, `src/server.js`) — um `setInterval` que chama o `sync()` **de cada origem**, e cada uma relê, compara e suprime por si: um watcher morto no `vend-server` não é motivo para reempurrar o `projetos`. Ela é quase de graça **por causa da supressão**: ~40 reconstruções/hora por origem a ~16ms, e na esmagadora maioria das voltas **zero byte no fio e zero re-render** — contra 720 reconstruções *com* 720 re-renders e ~44 MB/hora do polling. É 18× menos trabalho, e devolve ao board a única propriedade que o polling tinha de graça: **ele não consegue ficar em silêncio mentiroso por mais de 90 segundos.**
- **Indicador de conexão** (`public/shell.js`, `css/shell.css`) — o `.dot` que já existia no `<h1>`, com o estado em `data-conn` e as cores que já eram token. Ele não é enfeite: é a **única coisa na tela capaz de dizer *não sei***.

  | estado | cor | o que diz |
  | --- | --- | --- |
  | `live` | `--green` + halo | o board chega sozinho |
  | `retry` | `--amber` + halo pulsando | reconectando |
  | `dead` | `--red`, halo apagado | sem conexão — o que você vê pode estar velho |

  **A contagem até o vermelho corre desde o último `open`, não desde o último erro.** O `EventSource` erra a *cada* tentativa de reconexão (`retry: 2000`); rearmar o relógio a cada erro deixa o pontinho âmbar **para sempre** — que é uma forma mais educada da mesma mentira. E, uma vez vermelho, ele não volta ao âmbar a cada tentativa (piscaria de dois em dois segundos): só o `onopen` o traz de volta. Este bug existiu e só o navegador o pegou.
- **Botão de reler** (`public/shell.js`, `css/components.css`) — a válvula humana. Chama o `refresh()` do `router.js`, que bate no `/api/board` — que **relê o disco de verdade**, por dentro do `sync()`. O botão não é uma mentira; e se algo mudou, as outras abas também recebem o push.

O `EventSource` reconecta sozinho e o snapshot de conexão manda o **board inteiro, relido**. Restart de container se cura sem F5.

**`changed: []` quer dizer "não sei o que mudou", não "nada mudou".** É assim que o snapshot de conexão chega. Quem reconecta faz isso porque **alguma coisa esteve quebrada** — então quem receber uma lista vazia deve **reler no escuro** e deixar a supressão por conteúdo decidir, nunca tratá-la como "não me afeta". Acreditar no silêncio é a doença; a gaveta o faz certo (ver **A gaveta**).

## Os módulos do servidor

O lado servidor vive em `src/`, um assunto por arquivo:

| Módulo | Assunto |
| --- | --- |
| `src/board.js` | Monta a projeção de **uma origem** — esforços, issues, arestas de bloqueio. `buildBoard(ns)` é "leia o disco agora": **sem cache dentro**. E o `errorBoard()`, para a origem que não deu para ler. |
| `src/pads.js` | Os scratchpads de sessão — o root que **não é uma origem**. |
| `src/paths.js` | O `discover()` das origens e a tradução `path`/`ref` (`refIn`, `padRef`). |
| `src/watch.js` | O disco falando: `fs.watch` recursivo, debounce, reopen no `error`. **Só emite.** Um por origem. |
| `src/cache.js` | A supressão, **por origem**: `createCache(ns)` fecha o hash do board (`refresh()`) e o digest por arquivo (`movedFiles()`, `seed()`) dentro do namespace. |
| `src/server.js` | Só HTTP: rotas, estáticos, SSE, `safePath()`, `sync(ns)` e a varredura. |

O parser **não mora aqui**: ele é `shared/doc.js`, porque o browser também o importa.

`paths.js` existe por uma razão mecânica: se a tradução `path`/`ref` morasse no `server.js`, `board.js` e `pads.js` o importariam de volta — ciclo.

**Nada tem estado de módulo.** Os assinantes do SSE, os caches e os watchers nascem dentro do `start()` — dois servidores no mesmo processo não se enxergam. Era assim que o hash do `cache.js` vazava entre servidores, e é o tipo de acoplamento que só aparece num teste que ninguém escreveu ainda.

Os três diretórios (`src/`, `shared/`, `public/`) são montados **como diretório**, nunca arquivo a arquivo. O compose já montou `./server.js:/app/server.js`, e o preço apareceu no primeiro módulo novo: os testes passavam no host enquanto o container subia com código velho — ou estourava no import — porque ninguém lembrou de somar o arquivo ao `docker-compose.yml` e ao `Dockerfile`. Módulo novo em `src/` passa a valer sem tocar em nenhum dos dois.

O `shared/` **não** entrou em `src/`, e é deliberado: `src/` é o que só o servidor executa; `shared/` é o que os dois lados importam, e ele é **servido pela HTTP** (`/shared/`). Se essa rota estática cair, o board morre no import e **nenhum teste de unidade percebe** — por isso existe um teste HTTP que a cobre.

## Os módulos do cliente

`public/`, um assunto por arquivo. O `index.html` aponta para um único `<script type="module" src="/app.js">`, e o `app.js` tem **25 linhas**: ele só liga o fio (a gaveta ao documento, o hash ao roteador, o board à tela). **Quase nada mora nele** — se você procura uma função, ela está aqui:

| Módulo | Assunto |
| --- | --- |
| `dom.js` | `el()`, **`svg()`**, `esc()`, `api()`, `toast()`, `copy()`, `copyBtn()`, `pressable()` |
| `shell.js` | A moldura: `view`, `crumbs`, `tally`, as **abas de origem**, o indicador de conexão e o botão de reler |
| `state.js` | Os boards na mão do cliente — **um por origem** (`state.boards[ns]`), num **contêiner mutável**, não num `let` exportado (um binding exportado é cópia viva só para quem já importou) |
| `prompts.js` | `effortPrompts()` / `issuePrompts()` — o comando que destrava cada estado |
| `issues.js` | **Puro**: `cleanTitle`, `numberIndex`, `depsOf`, `openDeps`, `columnLabel`/`MIN_COLUMN_MS` |
| `graph-layout.js` | **Puro**: `layerize()`, `graphLayout()`, `edgePath()`, `NODE_W/H`, `GAP_X/Y`, `PAD` |
| `graph.js` | O desenho: nós em HTML posicionado, curvas em SVG |
| `edges.js` | A maquinaria de setas que grafo e Gantt compartilham: `edgeDefs()`, `edgeEl()` — os `<marker>` e a prosa do bloqueio no tooltip, uma vez só |
| `gantt-layout.js` | **Puro**: `ganttLayout()`, `arrowPath()` — o tempo virando geometria; o "hoje" entra por parâmetro |
| `gantt.js` | O desenho do Gantt: eixo de datas, barras em HTML posicionado, setas em SVG |
| `overview.js` | A visão geral e os chips de status |
| `effort.js` | A página do esforço: kanban, barra de documentos, viewswitch |
| `pads.js` | Os scratchpads de sessão |
| `drawer.js` | A gaveta: trilha, `wireRefs()`, redimensionamento, e a troca ao vivo |
| `router.js` | O hash decide a **origem** e a tela (`route()`, `activeNs()`, `refresh()`) e o `EventSource` (`connect()`) |
| `md.js` | O renderer do dialeto `.scratch` (importa `shared/doc.js`) |

**O esforço carrega a sua origem** (`effort.ns`) e o seu diretório (`effort.path`), e é assim que o cliente inteiro sabe em que board procurar. A alternativa era passar um `ns` de view em view até a gaveta — e a gaveta é justamente quem não pode errar: com um slug repetido entre origens, procurar o esforço no board errado não devolve `undefined`, **devolve o esforço errado**. O dado viaja com o objeto; ninguém precisa lembrar de repassá-lo. (`effort.path` é o outro lado disso: com um root só, o cliente remontava `board.root + archive + slug` na mão. Com N, essa conta é do servidor — quem sabe qual root montou o quê é quem os resolveu.)

As views **não esvaziam a tela antes de preencher**: `replaceChildren()`, nunca `innerHTML = ''` seguido de montagem. O `innerHTML = ''` garantia um frame em branco — 26 frames em branco pintados ao entrar em `#/pads`, medidos. Com `replaceChildren()` a árvore nova é montada de lado e trocada de uma vez: o navegador pinta **uma vez só**. Isso vale para `overview.js`, `effort.js` e `pads.js`, e é uma propriedade a manter, não um detalhe de estilo.

## O parser existe uma vez: `shared/doc.js`

`HEADER_KEYS`, `HEADER_LINE`, `preambleEnd()`, `parseDoc()`, `summarize()`, `splitBlockedBy()`, `parseBlockedBy()`, `normalizeStatus()`, o vocabulário `OPEN`/`CLOSED`/`KNOWN`, as `COLUMNS` e o `columnOf()` — tudo num arquivo só, importado pelo servidor **e** pelo browser.

Ele já existiu **duas vezes**, uma cópia no `server.js` e outra no `public/md.js`, por uma razão que *parecia* boa: um roda no Node, o outro no browser. Mas os dois são ESM no mesmo filesystem — o servidor passou a servir `shared/` estaticamente e o browser o importa. A razão evaporou, e a duplicação **já tinha cobrado juros**: as duas cópias divergiram, e o servidor era a errada (ver `Blocked by:`, abaixo).

Três consequências operacionais que não se pode perder:

- **`shared/doc.js` é puro** (`string → objeto`) e **não pode tocar `node:` nem o DOM**. É o preço de rodar dos dois lados.
- **O especificador é `../shared/doc.js`, e resolve dos dois lados**: no filesystem, `public/md.js` → `shared/doc.js`; na URL, `/md.js` → `/shared/doc.js` (o browser descarta o `..` na raiz). É o único specifier que serve ao Node e ao browser sem import map. **Não mova o `md.js` para um subdiretório de `public/`** sem refazer essa conta.
- **A forma do `blockedBy` no payload é contrato**: `{ number, note, raw }`. `splitBlockedBy()` devolve `{ number, label, note, raw }` porque o renderer precisa do `label` (o número **como o autor escreveu**: um `Blocked by: 8` deve ser desenhado `8`, não `08`), mas `parseBlockedBy()` **projeta o `label` fora** antes de serializar. Não é zelo: campo novo que vaze para o board serializado **move o hash da supressão**.

## Os três dialetos de cabeçalho

O `.scratch/` acumulou três formatos, e o parser precisa dos três. As chaves `Chave: valor` podem vir **antes** do `# Título` (dialeto do wayfinder, com `Type:` e `Blocked by:`) ou **depois** dele (dialeto do issue tracker e do restore-tui).

Por isso `parseDoc()` varre o **preâmbulo inteiro** — do topo até a primeira seção `## ` — em vez de só o bloco inicial. E aceita apenas as chaves de `HEADER_KEYS`, para que uma frase em prosa com dois-pontos não vire estado por acidente. Há `Status:` em corpo de issue (dentro de `## Acceptance criteria`); a fronteira do `## ` é o que impede que sejam lidos.

A lista fechada de chaves protege o *parser*, mas atrapalha quem quer **resumir**: os documentos trazem `Data:`, `Labels:` e o que mais o autor inventar, e nenhuma dessas chaves está em `HEADER_KEYS`. Por isso `summarize()` não filtra por chave — começa **depois** do preâmbulo. Sem isso, `Data: 2026-07-12` vira o resumo de um PRD (aconteceu). A fronteira do `## ` não depende de adivinhar chave nenhuma: acima dela é metadado, abaixo é texto.

`Blocked by:` também não obedece ao formato que promete. Na prática existe `Blocked by: 01 (resolvido), 02 (done), 08 — a revisão achou defeito crítico…, senão o shadow emite lixo`. Só o número que **abre** cada fragmento separado por vírgula é referência; o resto é prosa, e prosa a ser lida — é a justificativa do bloqueio.

Isso vale no servidor e no renderer, e **o servidor já errou aqui** — é o bug que a duplicação causou: ele guardava o fragmento inteiro e o procurava na lista de issues, o que nunca acha ninguém quando há prosa junto do número, e a issue ficava silenciosamente **não bloqueada**. O renderer estava certo. `parseBlockedBy()` quebra cada fragmento em `{ number, note }`: o número resolve a aresta, a nota é a justificativa que o hover do grafo devolve. Fragmento sem número que o abra (`(nada — pode começar já)`) não referencia issue nenhuma e não vira dependência.

## Dois vocabulários de caminho

Todo item da API carrega dois nomes para o mesmo arquivo: `path`, o caminho **dentro do container** (`/workspace/scratches/<ns>/...`), por onde o board lê; e `ref`, o caminho **como o workspace o vê** (`.scratch/...`, `vend-server/.scratch/...`), que é o único que faz sentido colar num agente.

O `ref` é derivado no servidor (`refIn`, em `src/paths.js`), não no cliente: quem sabe qual root montou o quê é o processo que resolveu os roots — e com N origens isso deixou de ser uma preferência de arquitetura e virou a única forma correta. `HOME_NS` diz qual origem é a de casa (a única de `ref` nu); `PADS_REF` faz o mesmo pelos scratchpads.

A regra prática: **o board lê por `path`; o humano copia `ref`.** Um comando com `/workspace/` dentro não leva a lugar nenhum — e um `.scratch/...` nu copiado da origem errada leva a **outro lugar**, que é pior.

O `changed` do push fala **`path`**, o mesmo vocabulário do que a gaveta tem aberto — comparação direta, sem tradução. Os dois caminhos nascem em lugares diferentes (`paths.js` e o `fs.watch`) e são comparados com `===`: uma barra a mais de um lado mataria a gaveta viva **sem um único erro**. Um teste guarda essa igualdade.

## Do que se trata este esforço

`pos-2101-flapping-guard` não conta história nenhuma, e abrir o PRD para lembrar custa uma navegação. Cada esforço carrega, direto do `/api/board`, o **título** e o **primeiro parágrafo** (`summarize()`) do `map.md` — ou do `PRD.md`, quando não há mapa; o mapa manda porque é o documento que o wayfinder mantém vivo, enquanto o PRD congela na intenção original.

Os dois vivem **no card**: o título abaixo do slug, o parágrafo em três linhas clampadas abaixo dele.

Já moraram num popup de hover, e o hover era a parte errada da frase. No celular ele não existe — o board simplesmente não tinha resumo lá —, e no desktop custava posicionar um flutuante contra a viewport na mão, a cada card. Pior: com o resumo no card, o popup passou a mostrar exatamente o mesmo texto por cima dele. Três linhas dizem o mesmo em qualquer dispositivo, e quem quiser o resto abre o documento — que é para onde o card leva de qualquer jeito.

## Copiar

Slug, título, caminho e comando são copiáveis com um clique. As regras de UI que o `copyBtn()` (`public/dom.js`) encapsula, e que qualquer alvo copiável novo deve herdar:

- **O botão fica sempre no DOM**, invisível por opacidade até o hover do container ou o foco. Escondê-lo com `display:none` o tiraria da ordem de tabulação — quem navega por teclado nunca chegaria nele. Em touch (`hover: none`) ele é sempre visível, porque não há hover para revelá-lo.
- **A confirmação é local**: o ícone vira ✓ verde por um instante. O toast do rodapé continua, mas com vários botões na tela ele não diz *qual* copiou; o ✓ diz.
- **Copiar não é navegar**: quase todo alvo mora dentro de algo clicável (card que navega, linha que abre a gaveta), então o clique do botão para no próprio botão (`stopPropagation`).
- **Copia-se o que se lê.** O comando aparece literal na tela e é ele que vai para a área de transferência. Nada de botão que copia algo que você não viu.

O título da issue é copiado **sem** o prefixo `NN — ` que o `.md` repete: o que se cola num prompt é o nome, não a numeração.

## Prompts de skill

Cada estado tem um comando que o destrava, e o board monta esse comando com os caminhos certos. Ele **não invoca skill nenhuma** — dispara quem lê.

| Estado | Comando |
| --- | --- |
| Esforço com `map.md` | `/wayfinder <ref>/map.md` |
| Esforço arquivável | `/scratch archive <slug>` |
| Só `PRD.md`, sem issues | `/to-tickets <ref>/PRD.md` |
| Esforço sem documento nenhum | `/wayfinder` (chartar o mapa) |
| Issue com `Type:` sob um mapa | `/wayfinder <ref>/map.md <issue-ref>` |
| Issue em `needs-triage`/`needs-info` | `/triage <issue-ref>` |
| Issue `ready-for-agent` | `/implement <issue-ref>` |
| Issue `ready-for-human` | `/grilling <issue-ref>` |

O wayfinder é o resolve-tudo: onde existe mapa, ele escolhe o ticket na frontier, reivindica e resolve — não há o que decidir no board, então ele vem primeiro e leva o destaque. Os outros comandos só aparecem onde o wayfinder não alcança.

Issue **bloqueada não recebe comando algum**. Oferecer o prompt seria convidar a furar a fila que o `Blocked by:` desenhou; o board mostra o bloqueio e cala a boca. Esforço arquivado também não: é leitura.

O `<ref>` já vem qualificado pela origem (`/implement vend-server/.scratch/...`), porque o servidor o derivou contra o root certo — o `prompts.js` não sabe que existem origens, e não precisa saber.

Se o vocabulário de skills mudar, o mapeamento vive inteiro em `effortPrompts()` e `issuePrompts()` (**`public/prompts.js`**) — um lugar só, e é onde ele deve continuar.

## A gaveta

Onde você lê o documento e decide o que fazer com ele. O `.md` chega **renderizado** (`public/md.js`); o que não é markdown — rascunho de agente, log, JSON — continua monoespaçado e literal.

`md.js` não é um renderer de propósito geral: é o dialeto que as skills escrevem, e é esse conhecimento que o faz valer mais que um `<pre>`.

- O **cabeçalho** vira bloco de metadados no topo, sempre na mesma ordem — o que normaliza a *exibição* dos três dialetos sem tocar no arquivo.
- **`Blocked by:`** vira link: clicar abre a issue bloqueante na própria gaveta.
- **Caminho de arquivo** vira alvo copiável (clicar copia; o texto na tela é o texto no clipboard).
- **Link relativo** (`[review-01.md](../review-01.md)`) — a forma como os documentos de um esforço se citam — vira navegação: abre o destino na gaveta. Uma **trilha** guarda o caminho de volta (`←` no topo, ou `Esc`); sem ela o link trocaria o contexto que você tinha por um que você não pediu.

Duas armadilhas do renderer, ambas já pagas:

- **Ordem das transformações.** Tudo que já virou HTML sai de cena como marcador e só volta no fim. Sem isso o regex de caminho encontra o `href` que o regex de link acabou de escrever e enfia um `<button>` dentro do atributo — HTML quebrado, e o link morre.
- **Especificidade.** As regras do corpo renderizado precisam do id (`#drawer-body.md`), não só da classe: `#drawer-body` (0-1-0-0) vence `.md` (0-0-1-0) em qualquer ordem de arquivo, e o documento inteiro sai monoespaçado, com os `\n` entre blocos virando linhas em branco.

A gaveta é **redimensionável** pela alça na borda esquerda (duplo clique volta ao padrão). A largura vive em `localStorage` — a única coisa que o board guarda fora dos `.md`, e não fere o princípio: a fonte da verdade é o *conteúdo*, e largura de painel não é conteúdo. Nenhum agente lê, nenhum arquivo depende, e perdê-la não perde nada. Em tela estreita a gaveta ocupa tudo e a alça some — não há o que arrastar.

### A gaveta é viva

Quando o arquivo aberto muda no disco, **o conteúdo é trocado por baixo de você**. É o caso de uso que motiva o push inteiro: *o agente está escrevendo o ticket que você está lendo*. Ela vive inteira no `public/drawer.js` — zero linha no servidor —, escuta o `board:push` que o `router.js` publica, e compara o `changed` com o que tem aberto.

- **A rolagem é preservada, e isso não é polimento.** Sem ela a gaveta viva é *pior* que a morta: ela te joga ao topo, no meio do parágrafo, toda vez que o agente salva. A linha que zerava o `scrollTop` **incondicionalmente** virou `const top = live ? body.scrollTop : 0` — na abertura ela continua zerando, e agora isso é o *caso particular* de um documento ainda não rolado. Medido: documento de 9733px numa janela de 277px, rolado ao meio, escrita real no disco, `scrollTop` **4867 → 4867**, e a mesma seção sob os olhos (`elementFromPoint()`). É a primeira decisão que alguém "simplifica" ao mexer no `render()`.
- **`shown` é a supressão da gaveta** — o conteúdo que está na tela. É o análogo exato do hash do `cache.js` um andar abaixo: relido e byte-idêntico, não se troca nada, não se mexe na rolagem e não se acende o realce.
- **`changed: []` quer dizer "não sei o que mudou", não "nada mudou"**, e a gaveta **relê no escuro**. É a decisão menos óbvia daqui e a mais fácil de "otimizar" fora: tratar a lista vazia como "não me afeta" seria a gaveta **escolhendo acreditar no silêncio** — a doença que este board inteiro existe para curar, no lugar em que o usuário mais olha. Relê sempre, redesenha só por um motivo verdadeiro; quem decide é o `shown`.
- **A moldura vem do board; o corpo vem do arquivo — e os dois envelhecem separado.** O `opts` (sobrancelha, título, comando de skill) era montado na abertura e congelava o board daquele instante: a gaveta mostrava um documento `Status: resolved` sob uma sobrancelha `claimed`, e oferecia o comando errado. `freshOpts()` recalcula contra o board que **acabou de chegar**.
- **A troca ao vivo reusa o `render()` inteiro**, e é de propósito: o `wireRefs()` já rodava depois de todo `innerHTML`, então o `Blocked by:` que linka, o caminho que copia e o link relativo que navega continuam vivos no conteúdo novo **de graça**. Um caminho paralelo que escrevesse HTML na mão devolveria um documento bonito e morto.
- **O realce (`flash()`) existe *por causa* da rolagem preservada**, não apesar dela: como a troca é invisível — o parágrafo sob os seus olhos continua no mesmo lugar, com outro texto —, ele é a única pista de que ela aconteceu. Conteúdo que muda debaixo do olho sem avisar é assombração.
- **"O arquivo sumiu" é um estado, não um erro.** O `/api/file` responde 404 `não encontrado`; a gaveta separa esse 404 de um erro qualquer e diz o que ele é, **por cima do texto que você estava lendo** — apagar a tela porque o agente renomeou um arquivo seria punir quem lia pelo que o agente fez. Âmbar, não vermelho: sumir não é erro do board, é fato do disco. E não é terminal: um `rename` é um sumiço seguido de um nascimento, e se o arquivo voltar o push seguinte limpa o aviso sozinho. A constante `MISSING` do `drawer.js` **é a string que o servidor responde** — traduzir uma sem a outra devolve o erro cru, e nada mais no projeto olha para ela (há teste).

A gaveta continua **sem escrever um byte**: ela lê, e só.

## As folhas de estilo

Não há `style.css`. As 1755 linhas dele viraram **nove folhas por assunto** em `public/css/`, servidas por nove `<link>` — o navegador as busca em paralelo, que é o ponto de não usar `@import` (sem bundler, `@import` é serial e render-blocking).

| Arquivo | Assunto |
| --- | --- |
| `css/base.css` | **Os tokens e os breakpoints.** `:root`, os degraus de escala (640px, 1024px), o `@media (hover: none)`, o esquema claro, o reset e o `body`. |
| `css/shell.css` | A moldura: topo (e o `.dot` da conexão), trilha, `main`, cabeçalho de seção, `#toast`, `.empty`. |
| `css/efforts.css` | A visão geral: `.grid` e o card `.effort`. |
| `css/pads.css` | O segundo root (`#/pads`). |
| `css/components.css` | O que reaparece em mais de uma tela: `.copy`, `.prompt`, `.chip`, `.actionbar`/`button.act`, o botão de reler, `.viewnote`. |
| `css/kanban.css` | `.board` (flex), `.col`/`.col.is-empty`, `.card`. |
| `css/drawer.css` | O painel: `#scrim`, `#drawer`, `#drawer-grip`, `.drawer-head`, `button.icon`, `#drawer-actions`, `#drawer-body` (incluindo `.swapped` e `.gone`). |
| `css/markdown.css` | O documento renderizado: `#drawer-body.md`, o bloco `.meta`, os alvos do renderer. |
| `css/graph.css` | `.viewswitch`, `.graph`, `.gedge`, `.gnode`. |
| `css/gantt.css` | O Gantt: `.gtick` (o eixo), `.glabel`, `.gbar` — e a borda aberta do piso (`.is-floor`). As arestas reusam as classes do `graph.css`. |

**A ordem dos `<link>` é a cascata**, e reproduz a ordem do antigo arquivo único — está comentada no `<head>`. Mexer nela é mexer no desempate entre regras de mesma especificidade.

**A regra do corte, e ela é a que se quebra sem perceber: token novo ou breakpoint de escala vai *só* no `base.css`.** Numa folha de assunto, uma `@media` de largura só se justifica quando o que muda é a **forma** (a gaveta que vira painel lateral, o `.meta` que vira duas colunas) — **nunca o tamanho**. Se for só tamanho, é token.

As decisões que o corte carregou intactas:

- **Mobile-first e por token**, não desktop-first por exceção. O layout nunca pergunta o tamanho da tela: ele lê `--gutter`, `--gap`, `--fs-doc`, `--card-min`, `--kcol-min` e `--tap` do `:root`. Os breakpoints reajustam **os tokens**.
- **A tipografia de leitura é maior no celular que no desktop.** `--fs-doc` vai de 15,5px para 13,5px conforme a tela cresce — o corpo do `.md` é o único texto da página cujo trabalho é ser lido de ponta a ponta, e no telefone isso se faz a um palmo do olho. A relação é *inversa* à largura, então um `clamp()` em `vw` a inverteria. Daí mobile-first: o valor base é o do celular, e o `min-width` desce dele.
- **`--tap` responde ao dispositivo, não à largura** (`@media (hover: none)`), que é a pergunta certa: quem não tem hover não tem precisão, e é aí que os alvos crescem para 40px e o botão de copiar deixa de depender de um hover que não vai acontecer.
- **O kanban é flex, não grid.** Num grid toda coluna leva seu `1fr` mesmo vazia, e um estágio zerado reservava um quarto da tela para não mostrar nada. No flex, a coluna com issues cresce e a vazia encolhe até o rótulo (`.col.is-empty`) — ela continua visível, porque saber que o estágio existe e está zerado é informação, mas deixa de custar espaço. Por dentro, a coluna é uma grade fluida de cards.
- **O grafo é a exceção assumida**: os nós têm pixel fixo porque a posição das curvas é calculada em cima dele. No celular ele não vira coluna — continua o mesmo desenho, e se lê arrastando **dentro** do contêiner. O que a folha garante é que a *página* nunca role para o lado; o que é largo (grafo, tabela, bloco de código) rola dentro de si.

Uma arrumação pendente, para quem passar por ali: **`button.icon` ainda mora no `drawer.css`** (era exclusivo da gaveta) e hoje o botão de reler, no cabeçalho, o herda. Ele deveria estar no `components.css` — a folha do que reaparece em mais de uma tela. **Mover, não duplicar.**

## O grafo de dependências

A página de um esforço tem três visões — lista, grafo e Gantt —, e a escolhida vive no **hash** (`#/<ns>/<slug>/grafo`, `#/<ns>/<slug>/gantt`) — não em `localStorage`: é onde já vive o resto da navegação, e assim cada visão de um esforço vira um link colável.

O grafo nasceu de querer as setas de um Gantt sem o Gantt. Um Gantt gasta o eixo X com tempo, e o `.scratch/` não tem data de início nem duração; inventá-las à mão em cada `.md` criaria um estado que ninguém mantém, e **data podre mente com mais confiança que a ausência dela** (ver **Carimbo de filesystem não é eixo de tempo**). Mas as setas não precisam de tempo: elas são as arestas do `Blocked by:`, e essas existem. Trocado o eixo por **profundidade**, a camada 0 passa a ser a frontier — o que dá para atacar agora — e cada coluna à direita é o que aquilo destrava.

O **layout é puro** (`public/graph-layout.js`) e o **desenho é DOM** (`public/graph.js`). A separação não é cosmética: é o que torna os invariantes abaixo testáveis sem um DOM — e um teste lê o fonte e **falha** se `document`, `window`, `localStorage` ou `innerHTML` aparecerem no módulo puro.

Como ele se sustenta:

- **A camada é o maior caminho** até uma issue sem dependência, não o menor. Com o menor, um nó apareceria à esquerda de algo que ele espera e a seta andaria para trás. A forma forte do invariante, e a que está no teste: **nenhuma aresta anda para trás**.
- **Ciclo não estoura** — e vale contar o episódio, porque esta linha foi **falsa durante todo o tempo em que esteve escrita aqui**. A aresta que fechava o laço não era ignorada: ela valia profundidade **0**, e um `0` ainda entra na conta como `depth(dep) + 1`. Num ciclo puro ninguém sobrava na camada 0, o `columns` nascia com um buraco e o `graphLayout()` estourava um `TypeError`. Ele não estourava a pilha — estourava em outro lugar. Quem o pegou foi o **teste**, escrito ao separar layout de render; o conserto é uma linha (a aresta que fecha o laço é **descartada**), provadamente inerte em grafo sem ciclo. O board mostra o que o arquivo diz, e um arquivo pode estar errado.
- **Dentro da camada, a ordem é o baricentro** das dependências: o nó fica na altura média de quem o bloqueia. É o que evita cruzamento gratuito de curvas. Cuidado: o baricentro decide a **ordem**, e a linha é reindexada de 0 a n-1 depois — o nó *não* fica na altura absoluta de quem o bloqueia.
- **A altura do nó é fixa** (`NODE_H`) porque entra no cálculo da posição das curvas. Título que estica desalinha as setas — daí o clamp de duas linhas.
- **Issue fechada continua no grafo**, esmaecida: é ela que explica o que soltou a frontier. Sem ela, uma issue destravada apareceria solta, sem história. A aresta já cumprida entra tracejada e verde; a que ainda segura alguém, sólida e vermelha.
- **A prosa do `Blocked by:` é o tooltip da aresta** — a justificativa do bloqueio é o que se lê antes de decidir furar a fila.
- **Os nós são HTML posicionado; o SVG só desenha as curvas.** Assim o chip de status, o foco por teclado e o clique que abre a gaveta são os mesmos da lista, sem reimplementar texto em SVG. Cuidado ao mexer: `el()` monta HTML, e um `<defs>`/`<marker>` criado por ele **não estaria no namespace SVG** — o navegador aceita e ignora, e as setas somem **sem erro nenhum**. Por isso o `svg()`, que hoje mora ao lado do `el()` no `dom.js`, com o porquê escrito entre os dois.

O grafo não inventa nada: as referências do `Blocked by:` são locais ao esforço — logo, locais à origem —, então ele nunca cruza slugs nem repositórios, e um esforço sem nenhuma aresta vira uma coluna só, com uma nota dizendo isso em vez de fingir um desenho.

## Carimbo de filesystem não é eixo de tempo

Isto está escrito aqui porque **a ideia é atraente e o dado *parece* existir** — sem este parágrafo, alguém vai tentar de novo.

O `birthtime` existe no ext4 e parece a data de criação do ticket. **Ele não é.** O `Write` dos agentes reescreve o arquivo inteiro, o que **cria um inode novo** — e inode novo tem `birthtime` novo. Medido na frota: um ticket `resolved` (escrito, trabalhado e fechado ao longo de dias) tem `birthtime == mtime`, e a **mediana de `Δ birth→mtime` é 0s** em quase todos os esforços — não porque os arquivos nunca mudaram, mas porque a mudança **apagou o rastro de que eles existiam antes**.

Um Gantt construído sobre isso sairia com **barras de duração zero**.

### Mas o diretório sobrevive — e essa frase acima é generalizada demais

**Cuidado com o título desta seção: ele está certo sobre *arquivo* e errado sobre *diretório*.** A generalização confiante quase matou uma solução inteira, e por isso a correção vem escrita junto.

**Ninguém recria um diretório.** O `mkdir` acontece uma vez, e o `Write` atômico de um `.md` lá dentro não toca o inode do diretório. Então:

- **O `birthtime` do diretório de um esforço é a data de criação dele — de verdade.** E ele **sobrevive ao `mv` do arquivamento**, porque `rename` preserva inode. Medido nos três esforços já arquivados: `birthtime` de 10/07, 10/07 e 12/07, com o `ctime` marcando o `mv` (12/07). **Isso é início e fim reais de um esforço, no disco, hoje.**
- **O `mtime` de um ticket `resolved` é, na prática, a resolução dele** — a última escrita num ticket fechado *foi* a que o fechou. Medido: os 14 tickets do `scratch-board-push-refactor`, ordenados por `mtime`, saem em `01 → 02 → 08 → 03 → 04 → 05 → 06 → 07 → 11 → 10 → 12 → 09 → 13 → 14` — **exatamente** a ordem de resolução que o mapa registra.
- **O `mtime` de um ticket parado é quando ele entrou no estado atual**, porque ticket encalhado é, por definição, ticket que ninguém tocou.

Ou seja: **há backfill, e ele é real.** O que *não* se recupera é o `created` **por ticket** — para isso, o diretório do esforço dá um **piso** honesto (o ticket não pode ser mais velho que o esforço).

## O Gantt de um esforço

`#/<ns>/<slug>/gantt`, a terceira aba do viewswitch. **É o grafo com o X virando tempo**: o grafo nasceu de querer as setas de um Gantt sem ter o eixo (ver a seção acima) — e o eixo estava no cabeçalho o tempo todo, na transição de `Status:` que o **catálogo** (`src/history.js`) persiste. Mesmas setas do `Blocked by:`, mesma prosa no tooltip, X virando tempo — e agora tempo que é **fato**, não o `mtime` que mentia.

**Sólido é fato, hachurado é cerco.** É a espinha do desenho, e a regra que separa as barras:

- **sólido** — o servidor **observou** o ticket transicionar (o catálogo tem a sequência de colunas). A barra se **subdivide pelas colunas** (`triagem`/`pronto`/`curso`/`fechado`): é daí que sai o "tempo em coluna". A borda direita é a **resolução** (o último carimbo de transição) ou "hoje", se aberto.
- **hachurado** — o servidor **nunca** o viu andar. A barra sai hachurada sobre o **cerco** do esforço (o `created`→`ended` do diretório) — "aconteceu em algum momento aqui dentro". **Hachurado é um intervalo que *contém* o fato, nunca um fato**: é o que deixa os ~130 tickets antigos aparecerem no primeiro dia sem uma única data inventada. Cada transição que o servidor observar **solidifica** a barra.
- **até hoje** — ortogonal aos dois: ticket aberto corre até "hoje" (do navegador, nunca do payload — um "hoje" do servidor envelheceria e empurraria o board parado).

**O que atravessa o fio, e por que não fere a supressão.** Cada issue carrega `bar: { measured, segments: [{ column, start }] }` — o carimbo de cada faixa é o instante **imóvel** da transição (ISO absoluto). Uma vez que `pronto → curso` aconteceu às 14h02, nenhum salvamento futuro move esse byte, então ele atravessa com precisão de segundos **sem mover o hash** — ao contrário do `mtime`, volátil. O esforço carrega `created` e `ended` (dias UTC do `birthtime`/`ctime` do diretório) para o cerco. O `birthtime` é imóvel de verdade; o `ctime` **não** — um `chmod`, um restore de backup o movem —, mas ele só entra como `ended` no esforço **arquivado**, que está congelado, e em granularidade de dia: estável na prática, não por natureza. **A observação vem *depois* da leitura no mesmo `sync()`**, então a faixa nova de uma transição aparece no ciclo seguinte (a próxima escrita ou a varredura de 90s) — um atraso de retaguarda numa tela retrospectiva, não um push fantasma.

**A escala é parâmetro, não um `if`** (`pxPerMs`). O Gantt do esforço mede em **horas** (`HOUR_W`) porque suas issues duram horas ou minutos; o Gantt global (ticket 05) mede em **dias** (`DAY_W`), a mesma função. **A barra desenha a duração real, até o minuto**: um ticket que o agente fechou em 20 minutos é uma fatia proporcional entre duas horas, nunca arredondada — a precisão que o carimbo imóvel deu de graça, e que o desenho não joga fora (foi por não tê-la que o Gantt de `master` virou um leque). Só abaixo do piso de legibilidade (`MIN_BAR_W`) a barra ganha largura mínima, e a duração exata vai no tooltip.

Como o grafo, **o layout é puro** (`public/gantt-layout.js`) **e o desenho é DOM** (`public/gantt.js`) — os invariantes moram em `test/gantt-layout.test.js`, com o mesmo guarda que proíbe o módulo puro de tocar `document`/`innerHTML` (e um a mais: `Date.now` — o "hoje" entra por parâmetro). Os que valem a pena conhecer:

- **nenhuma barra começa depois de terminar** — nem quando o disco contradiz o cerco (um `ended` anterior ao `created`; a barra se recolhe em vez de nascer negativa);
- **a barra hachurada se distingue da sólida, e o cerco a contém** — o intervalo do esforço abrange as barras que ele cerca;
- **um ticket de 20 minutos não é arredondado** — duas durações sub-hora diferentes têm larguras diferentes; o piso não as achata;
- **nenhuma seta anda para trás no tempo** — a seta sai da resolução do bloqueante e entra na barra do bloqueado **dali em diante** (`max`), nunca na borda esquerda;
- **a mesma função, chamada com escala de dia, produz as posições do global** — a escala é parâmetro, e o teste prova chamando-a duas vezes;
- **ciclo não estoura** — de graça, porque não há recursão: cada aresta é geometria própria;
- **as linhas saem na ordem da resolução**, e as abertas afundam para o fim, correndo até a linha de "hoje".

Os rótulos e as barras são HTML posicionado (clique abre a gaveta, como na lista); as faixas por coluna são divs dentro da barra sólida; o SVG só desenha as setas — pelo `svg()`, pela mesma razão do grafo: um `<marker>` montado pelo `el()` some sem erro nenhum.

**O catálogo alimenta a barra, e perdê-lo degrada em vez de zerar** (`buildBoard(ns, history)`): sem catálogo, `observations()` devolve `[]`, toda barra nasce hachurada, e o cerco de disco (`created`/`ended`) continua de pé.

### O `mtime` no payload mata o push — mas a *ordem* não

A armadilha verdadeira é outra, e é fina. **O `mtime` cru não pode entrar no payload**: ele muda a **cada** salvamento do agente, o hash do board se move, e o evento vira `message` (~71 KB + re-render) em vez do `files` (~126 bytes). Isso colapsaria as duas supressões independentes (ver **Dois eventos**) — a regressão contra a qual `src/board.js:16` e `src/cache.js:13` avisam. O teste que proíbe a string `mtime` no board serializado é o guarda disso.

**Mas ordenar por `mtime` não exige publicá-lo.** O servidor ordena e **não emite o campo**: só a *ordem* viaja. O hash se move quando o **ranking** muda — que é quando a tela reordena de verdade, um push legítimo. O agente salva o ticket X, ele sobe ao topo, e os dez salvamentos seguintes **não movem nada**, porque ele já está em primeiro.

E o que precisa de carimbo visível ("em `pronto` há 6 dias") entra **imóvel**: um carimbo de **transição** do catálogo (o `held.at` da issue), que dez salvamentos não movem porque não é o `mtime` — ele só muda quando o `Status:` muda. O campo não se move, o hash não se move. Ver **"Em `<coluna>` há N"**.

**A regra que sobra, e essa é absoluta: nada de tempo *relativo* no payload.** O servidor manda ISO absoluto; o `"há 3 dias"` se calcula no navegador. Uma string relativa muda **com o relógio** — a varredura de 90s a recalcularia, o hash se moveria, e o board empurraria sozinho, parado, para sempre. Seria o polling ressuscitado, e pior: barulhento sem ninguém ter escrito nada.

O eixo de tempo vive em `.scratch/scratch-board-eixo-de-tempo/`.

## A ordem por atividade

**O esforço onde o agente está escrevendo é o primeiro card da tela, e dentro dele o ticket quente é o primeiro da coluna.** Os esforços saíam em **ordem alfabética** e as issues por nome de arquivo — nenhuma das duas carrega informação, e abrir a visão geral não dizia onde o trabalho estava acontecendo.

A técnica é a da seção acima, e é ela que faz isto ser barato: **para ordenar, publica-se a ordem — não o carimbo.** O `board.js` lê o `mtime`, ordena, e **o carimbo cru morre ali** (`buildBoard()`, no `.map()` final) — o que atravessa o fio é a *ordem*, e mais nada. (O tempo que a issue *carrega* — o `held`, que a seção **"Em `<coluna>` há N"** descreve — não vem do `mtime`: vem da transição de `Status:`, no catálogo.) O hash se move quando o **ranking** muda, que é quando a tela reordena de verdade.

Quatro decisões, e cada uma protege alguma coisa:

- **A atividade é a dos arquivos que o board *projeta* — nunca o `mtime` do diretório.** O do diretório pula quando qualquer entrada nasce, morre ou é renomeada lá dentro, inclusive um `.swp` de editor. Ordenar por ele faria um arquivo temporário reordenar a tela e empurrar o board — e o teste do `.swp` que não empurra nada é exatamente quem prende isso. A de um esforço é o **máximo** entre as issues e o `map.md`/`PRD.md`; um esforço sem documento nenhum vale `0` e afunda, porque não há o que datar e inventar uma data seria o board mentindo.
- **O carimbo viaja *ao lado* do documento, nunca dentro dele.** `readIssue()` e `readEffort()` devolvem `{ at, issue }` / `{ at, effort }`. Não é estilo: é o que impede o campo de ser serializado por acidente. Ele não precisa ser lembrado e removido na hora de montar o objeto — **ele nunca esteve no objeto**. Um `delete` antes do `JSON.stringify` seria a mesma garantia dependendo de alguém não esquecer.
- **A estabilidade do `sort` é load-bearing.** As entradas chegam em ordem alfabética (o `.sort()` do `readdir`, o `listSlugs`), então um empate de carimbo cai de volta nela — determinístico. Uma ordem que flutuasse no empate moveria o hash **sem ninguém escrever nada**: um push fantasma, que é o oposto exato do que a supressão comprou.
- **Ordenar a lista uma vez ordena dentro de cada coluna.** O kanban (`public/effort.js`) desenha a coluna filtrando `effort.issues`, e `filter` **preserva a ordem** — então não há ordenação no cliente, e não deve haver. É por isso que a ordem se afirma **pelo fio**, no `server.test.js`, em vez de por dentro do `board.js`: a ordem do array *é* a ordem da coluna.

**Os arquivados também saem por atividade.** O `mv` do arquivamento preserva o `mtime` dos `.md`, então a lista sai pela atividade que cada esforço teve em vida — o último a ser encerrado no topo. Era alfabética; a mudança veio de graça e informa mais.

### A rajada de criação não é atividade

**Ticket ordena por tempo — exceto dentro de uma rajada, onde manda o número.** (Esforço ordena por tempo puro; ele não tem número.)

**O `/to-tickets` escreve `01…07` de uma vez**, com ~20s entre um e outro. Pelo `mtime` puro, o `07` fica sendo o mais recente e a coluna sai **invertida** — a frontier (`01`) no fim, que é o pior lugar possível para ela.

E **isso não se conserta sozinho**, que é o que torna o defeito grave: um ticket em `ready-for-agent` é, por definição, um que **ninguém tocou** desde que nasceu — porque tocá-lo muda o `Status:`, e mudar o status o **tira da coluna**. A inversão seria permanente, e permanente justamente na coluna de onde se escolhe o trabalho.

**As duas populações não se tocam, e é isso que dá a solução.** Medido na frota:

| | intervalo entre escritas |
| --- | --- |
| rajada de criação (o agente compondo `01…07`) | **4s – 25s** |
| trabalho de verdade (reivindicar, resolver, tocar) | **≥ 389s** (~6,5 min) |

`BURST_MS` é **60s**: 2,4× acima do maior gap de rajada, 6,5× abaixo do menor gap de trabalho. Não é gosto — é o meio de um vale que existe no disco.

**Agrupa-se por lacuna, e não se quantiza o carimbo.** Um balde de tempo absoluto (`Math.floor(at / N)`) *parece* a solução óbvia e **não funciona** — vale escrever por que, porque é a "simplificação" que alguém vai propor:

- **Balde pequeno (minuto) parte a rajada no meio.** Sete tickets a 20s **abrangem 95–140 segundos**: a rajada atravessa dois ou três baldes, e a borda cai dentro dela. Sairia `06,07 → 04,05 → 01,02,03` — pior que a inversão limpa.
- **Balde grande (dia) apaga o que o board existe para mostrar.** O ticket tocado às 15h deixaria de subir sobre a rajada das 9h **do mesmo dia** — e "qual issue está sendo trabalhada agora?" é a pergunta que originou o esforço inteiro.

O que separa rajada de trabalho não é a **hora**; é a **distância entre elas**. Então é isso que se mede (`orderIssues`, em `src/board.js`).

A ordem é **função pura do conjunto de `mtime`s**: sem escrita, ela não muda — logo a varredura de 90s não reordena nada sozinha, e o board parado continua parado.

## "Em `<coluna>` há N": o card que admite estar encalhado

A ordem põe o trabalho **quente** no topo; este rótulo põe o trabalho **frio** em evidência. Um ticket encalhado há uma semana em `ready-for-agent` era visualmente idêntico a um que entrou na coluna há dez minutos — e o card agora diz **"em `pronto` há 6 dias"**: quanto tempo, **e em que coluna**.

**O eixo de tempo deste rótulo é o catálogo, não o `mtime`.** A primeira versão lia o `mtime` e mentia: um toque tangencial no `.md` — o `Blocked by:` de outra issue, um typo, o resultado de outro ticket derramado no mesmo esforço — **zerava o contador**. A feature que existe para revelar o ticket parado era a que o apagava (o caso do Taiga). O sinal verdadeiro é a **transição de `Status:`**, que o catálogo (`src/history.js`) persiste — e um toque no corpo não é transição nenhuma. O `projectColumnEntry()` (`src/board.js`) destila do catálogo o campo **`held: { at, floor }`**: o instante em que o ticket entrou na coluna atual, e se esse instante é fato ou piso.

O card mostra o rótulo em âmbar. Âmbar e não vermelho, pela mesma distinção que a gaveta faz com o arquivo que sumiu: **tempo na coluna não é erro, é fato do disco** — e o vermelho já é do `blocked-tag`, que diz outra coisa (ali alguém *segura* o ticket; aqui ninguém o tocou). É a **unidade** que faz o encalhe saltar: um `"há 6 dias"` no meio de vários `"há 20min"`.

As regras que o deixam atravessar o fio, e por quê:

- **Imóvel, não quantizado.** O `held.at` é um carimbo de **transição** (ou do primeiro `seen`), persistido no log e relido igual: dez salvamentos depois, o mesmo byte. Diferente do `mtime` cru, publicá-lo **não move o hash** — como os `start` da barra do Gantt. Não precisou virar dia para caber no fio; a precisão ao segundo viaja de graça, e é ela que deixa o rótulo descer para minutos.
- **A unidade acompanha a idade** (`elapsed()`, em `public/issues.js`). Boa parte do trabalho aqui dura menos de um dia, e `"em curso há 0 dias"` não diz nada: abaixo de um dia o rótulo desce para **horas**, abaixo de uma hora para **minutos** — `"em curso há 40min"`. O relativo e a unidade são conta do navegador; o servidor manda só o instante.
- **Piso quando não observado** (`floor`). Os tickets antigos que o servidor nunca viu transicionar não têm data de entrada na coluna — mas o catálogo sabe dizer *"eu o vi em `pronto` pela primeira vez há 3 dias e ele não saiu de lá"*, logo **"em `pronto` há ≥3 dias"**. O `≥` nunca mente, e o viés está no lado certo: **subestima** o encalhe, jamais o esconde. Ele some sozinho no instante em que uma transição observada preencher a coluna (`floor` vira `false`).

**O limiar mora no cliente** (`MIN_COLUMN_MS`, um minuto). Um ticket que entrou na coluna há segundos não informa encalhe nenhum: abaixo de um minuto o card cala, em vez de piscar `"há 0min"`. E é decisão de cliente pela mesma razão que o relativo é: fosse um corte do servidor, o ticket cruzando o limiar **enquanto ninguém escreve** mudaria o payload, e a varredura de 90s empurraria o board sozinho. O servidor publica o fato imóvel; quem envelhece é o relógio de quem olha.

**Issue fechada nunca recebe o rótulo.** O `held` viaja em todas elas (o Gantt quer a barra), mas `"em fechado há 30 dias"` num ticket `resolved` seria uma data verdadeira contando uma história falsa: ele não encalhou, terminou. Quem cala é o `columnLabel()`, no cliente.

**A retaguarda de um ciclo, que não é um bug e por isso está escrita.** A observação vem *depois* da leitura no mesmo `sync()`, então o `held` de um ticket recém-nascido (ou recém-transicionado) chega **no ciclo seguinte** — a primeira leitura o vê sem instante, a próxima escrita ou a varredura de 90s o preenche. É a mesma retaguarda da barra do Gantt, e por isso a subida **semeia o catálogo** (`server.js`): todo ticket que já está no disco ganha seu `seen` **antes de servir**, para o `held` nascer estável e a varredura de segurança continuar muda num board parado. A invariante absoluta segue de pé: *no ocioso, zero byte* — o carimbo é um fato do disco e não envelhece sozinho.

### A limitação assumida: na visão geral, a ordem vale *dentro* da seção

**E aqui a frase acima **não** se estende — cuidado, porque ela é convidativa.** A visão geral não desenha `board.efforts` de cima a baixo: o `overview.js` **particiona** os esforços em seções de ordem fixa — **Ativos → Prontos para arquivar → Parados → Arquivados** — e ordena por atividade **dentro de cada uma**.

O efeito é real e está assumido: um esforço recém-chartado (só `PRD.md`, sem issues) é `stalled`, então cai na **terceira** seção. Você acaba de escrever o PRD dele e ele aparece **abaixo** de um esforço ativo intocado há nove dias. Ou seja: *"o esforço quente é o primeiro card da tela"* vale **dentro da seção**, não na tela inteira.

Isto foi uma **escolha**, não um esquecimento. As duas saídas custavam mais do que o problema pede: ordenar as *seções* pela atividade do seu esforço mais quente poria "Parados" no topo, que é semanticamente esquisito; achatar tudo numa grade só jogaria fora uma classificação que alimenta os prompts de skill. Quem quiser resolver isso resolve um problema de **produto**, não de ordenação — e resolve na visão geral, não no `board.js`, que já publica a ordem certa.

**A leitura numérica não se perde**: o número continua em destaque no card, então o `03` que um `Blocked by:` citou continua achável — e a leitura estrutural (as arestas) vive no grafo.

## Os testes

`node --test test/` — **157 testes**, e o projeto não tinha nenhum. `node:test` e `node:assert` são builtin: **a zero-dependência sobreviveu**. Não há `jsdom` e não deve haver — as costuras caem onde o código já é puro, ou onde ele fala HTTP.

| Costura | O que trava |
| --- | --- |
| `test/doc.test.js` | O parser (`shared/doc.js`, puro): os três dialetos, o `Status:` do corpo que **não** vira estado, o `Blocked by:` com prosa, o `summarize()` pulando o preâmbulo, o status desconhecido virando `?`. |
| `test/md.test.js` | O renderer (`md.js`, `string → string`): a **ordem das transformações** e o `Blocked by:` que linka sem engolir a justificativa. |
| `test/graph-layout.test.js` | Os invariantes do grafo (puros): a camada é o **maior** caminho, nenhuma aresta anda para trás, ciclo não estoura, o baricentro, e o guarda que impede o módulo (e o `issues.js`) de voltar a tocar o DOM. |
| `test/gantt-layout.test.js` | Os invariantes do Gantt (puros): nenhuma barra começa depois de terminar (nem com o disco contradizendo o cerco), **hachurado distinto de sólido e contido no cerco**, aberto que corre até o "hoje" **do parâmetro**, **um ticket de 20 min que não arredonda** (e duas sub-hora com larguras distintas), **a mesma função com escala de dia** produzindo as posições do global, nenhuma seta para trás, ciclo que não estoura, e o guarda de pureza — com `Date.now` na lista proibida. |
| `test/issues.test.js` | O vocabulário puro do cliente: o rótulo **"em `<coluna>` há N"** — a unidade que acompanha a idade (dias/horas/minutos e a borda do singular), o **piso** com `≥` que vira fato, o fechado que nunca está "parado" (está pronto), o recém-entrado abaixo de um minuto que **cala**, e a ausência de instante que não vira data inventada. O "agora" entra por parâmetro; não há relógio a mockar. |
| `test/server.test.js` | **A costura mais alta.** Servidor de verdade em porta efêmera contra um `.scratch/` temporário, stream SSE lido com o `fetch` nativo, **arquivos escritos de verdade no disco**: o push, o debounce, a supressão, o esforço novo que aparece sem restart, o caminho fora do root recusado, os dois eventos (`message` × `files`), e a **segunda escrita atômica** do mesmo arquivo — o teste que o watcher derrubaria, e o que impede alguém de "simplificar" o digest de volta para a lista de caminhos. E a **ordem por atividade**: o esforço quente que abre a tela, a coluna do kanban ordenada, o ticket que **não era o primeiro** subindo ao topo num `message`, e os salvamentos seguintes — com ele **já em primeiro** — voltando a ser `files`. E o **tempo na coluna** (`held`): o instante imóvel que o ticket carrega (nenhuma string relativa viaja), o piso que vira fato ao transicionar, e o corpo reescrito sem mudar o `Status:` que **não move o `held`** — o caso do Taiga. O tempo se fabrica com `utimes()`; não há relógio a mockar. |
| `test/watch.test.js` | O reopen depois do `error`, e um root que ainda não existe. |
| `test/sweep.test.js` | A varredura de segurança. **Arquivo separado** porque ela precisa de um relógio curto (`sweep: 300`), e um servidor que empurra sozinho a cada 300ms envenenaria as asserções de silêncio do `server.test.js`. (Já foi separado por outro motivo — o hash de módulo do `cache.js` —, e esse motivo acabou.) É aqui também que vive o guarda do eixo de tempo: um board com um ticket **encalhado** (o `held` semeado na subida, um piso), atravessado por várias varreduras, continua **mudo** — é este teste que um `"há N"` calculado no servidor derrubaria. |
| `test/namespaces.test.js` | O que **só existe com mais de uma origem**: a descoberta e a ordem, o `ref` nu da de casa contra o qualificado das outras, **dois esforços com o mesmo slug** que não se confundem, o push que carrega o `ns` e **só o board da sua origem**, a supressão que **não atravessa** (escrever o mesmo byte numa não cega a outra), a origem vazia contra a **quebrada**, o erro que passa pelo hash em vez de gritar a cada varredura, e o snapshot de conexão trazendo uma origem por frame. |
| `test/drawer.test.js` | O que a gaveta **assume sobre o mundo**: que o `changed` fala o mesmo vocabulário de caminho que o board, que a string do 404 é a que ela procura, e que o esforço publica `ns` e `path` — os dois campos com que ela acha o board certo. |
| `test/pads.test.js` | A **poda** dos scratchpads: o `node_modules` do topo e o **aninhado**, as contagens, os bytes e a **recência** que ele não pode sequestrar, o vizinho recursivo que sobrevive com o `ref` absoluto real, a sessão que só deixou dependência e por isso some, e o arquivo *chamado* `node_modules` que **é conteúdo** — o teste que separa a poda na travessia de um filtro por nome depois dela. |

**Um bom teste aqui exercita comportamento externo, nunca o desenho interno.** "O debounce usa um timer de 120ms" é implementação e quebra na primeira melhoria; "seis escritas seguidas produzem **um** evento" é comportamento, e é esse que está escrito.

Fora de teste, deliberadamente: DOM, CSS, interação da gaveta, arrastar do grafo. Verificados **dirigindo o app de verdade** (chromium por CDP cru, nada instalado), não com um DOM falso.

Duas armadilhas de quem for medir ou testar o push:

- **Zere o disco entre rodadas.** A supressão (corretamente) engole uma segunda escrita idêntica, e isso parece bug.
- **Erro de import de módulo é mudo**: o board simplesmente não monta, e nenhum teste de unidade percebe. É por isso que existe o teste HTTP que busca `/`, `/app.js`, `/md.js`, `/router.js` e `/shared/doc.js`.

## Scratchpads de sessão

`/tmp/claude-0/-root-projetos/<session-id>/scratchpad/` é onde os agentes largam arquivo temporário. O board monta isso em `/workspace/pads` **read-only** e serve em `#/pads`.

**Eles não são uma origem**, e a distinção é de natureza, não de arrumação: uma origem é um `.scratch/` versionado que as skills mantêm; um scratchpad é lixo de sessão em `/tmp`, que some no reboot. Por isso `#/pads` fica **fora** das abas, é global (só a sessão deste workspace), e o `ref` de um pad é o **caminho absoluto real** — ele vale a partir de qualquer cwd, e é a única forma de ser colável. `safePath()` prende qualquer caminho vindo do cliente aos roots das origens **mais** este. Rascunho de agente o board lê e não toca — como, aliás, ele não toca em nada.

Os pads **não são vigiados**, e é decisão: eles vivem em `/tmp`, são escritos por toda sessão de agente e mudam muito mais que o `.scratch/`. Vigiar esse churn seria ruído puro. Eles continuam **sob demanda**, buscados quando você entra em `#/pads`. (O `ago()` usa o `mtime` dos *arquivos* de pad, que é coisa diferente do `mtime` de diretório que saiu do board.)

Sessão sem nenhum arquivo é omitida — a maioria nunca escreve nada e listá-las afogaria as poucas com conteúdo. O diretório vive em `/tmp`: some no reboot do WSL, e o board não promete o contrário. Não construa nada que dependa dele persistir.

### `node_modules` é deliberadamente invisível

Uma sessão que roda `npm install` no scratchpad larga uma **árvore de projeto inteira** ali. O board **poda** todo diretório `node_modules`, em qualquer profundidade — e a poda é da **travessia**, não da exibição: o `continue` vem antes da recursão, e os descendentes nunca são visitados. Medido contra um `node_modules` de 400 pacotes (14.400 arquivos): `listPads()` caía para **935ms** e o card anunciava **14.404 arquivos**, afogando os 4 rascunhos que a sessão de fato escreveu. Com a poda: **0,6ms** e **4 arquivos**. Filtrar depois de andar a árvore devolveria a lista certa **pagando a conta inteira** — é a "simplificação" que o `pads.test.js` mantém vermelha.

Nada de dentro de um `node_modules` entra em lugar nenhum: nem nos cards, nem na contagem, nem nos bytes, nem na **recência** (o `mtime` do card é o máximo dos arquivos, então um `index.js` recém-instalado sequestraria a ordem da lista e o "há N min"). Uma sessão cujo scratchpad é *só* dependência instalada some da lista — ela não rascunhou nada.

**O critério de pertinência é derivado × rascunhado, e não peso.** `node_modules` não é o que a sessão escreveu: é o que uma ferramenta baixou para ela, é reconstruível a partir de um `package.json`, e ninguém vai abrir um arquivo dele na gaveta. `__pycache__` e `.venv` passariam no mesmo teste no dia em que aparecerem. **Um diretório de saída não passa** — um `data/` com 560 MB de CSV e um `.duckdb` que o agente gerou *é* o trabalho da sessão (existe um, na frota, e o board o mostra inteiro: 52 arquivos, 831,9 MB). Podá-lo por ser grande seria o board mentindo sobre o que a sessão fez, e mentir sobre o disco é o pecado que este projeto existe para não cometer. Quem quiser esconder peso tem a gaveta, que já recusa exibir acima de 512 KB.

A poda é de **diretório**, não de nome: um arquivo comum que por acaso se chame `node_modules` é conteúdo, e continua visível. Há teste, e é ele que separa a poda de verdade do filtro por nome.

Artifacts do claude.ai ficaram **de fora** por não existirem em disco: são uma API remota que só o agente alcança. Não há o que montar.

## Vocabulário de status

Canônicos (`docs/agents/triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
Do wayfinder: `claimed`, `resolved`. Vistos na prática: `done`, `partial`.

Um status fora dessa lista é exibido com `?` e em vermelho — vocabulário novo deve **aparecer**, não sumir num balde de "outros".

## Classificações do board

- **Arquivável** — tem issues e todas fecharam. Pronto para `/scratch archive`.
- **Parado** — nunca foi decomposto em issues (só PRD), ou tudo que existe está preso em triagem. Note que é sobre *movimento*, não progresso: um esforço com `ready-for-agent` está enfileirado, não parado, mesmo com zero issues fechadas.
- **Ativo** — o resto.

## Fronteira

O board mecaniza o que é determinístico: ler o estado, resumir o documento, **montar o comando**. O que exige julgamento — decidir que um ticket está resolvido, destilar o aprendizado de um esforço em memória antes de arquivá-lo, escolher como atacar uma issue — é das skills, e **muda os `.md`**. O board não muda `.md`.

É por isso que ele copia prompts em vez de disparar agentes, e é por isso que o drag-and-drop saiu. Compor `/wayfinder .scratch/x/map.md` é determinístico; decidir que agora é hora de rodá-lo, não. E marcar um ticket como `resolved` arrastando um card é dar o veredicto sem fazer o trabalho que o justifica.
