# AGENTS.md — scratch-board

Board de leitura do `.scratch/` do workspace. Serve para enxergar os esforços em curso, lembrar do que cada um se trata, ler os documentos e sair com o comando que destrava o próximo passo.

## O princípio

**Os `.md` são a fonte da verdade. O board é uma projeção — e só isso.**

O board **não escreve**. Quem muda status é você ou a skill que resolve o ticket, no arquivo; o board **é avisado** e mostra o resultado — sem refresh, sem F5, sem esperar relógio nenhum. Não há banco e não há índice.

Existe **cache**, e ele não fere o princípio — mas a distinção é fina o bastante para merecer estar escrita, porque é ela que alguém vai atropelar. O cache do `src/cache.js` é **derivado**: um watcher relê o disco e o reconstrói inteiro a partir dos `.md`. Ele não é um estado paralelo que alguém edita, ninguém escreve nele pela lateral, e **nenhuma rota o serve no lugar do disco** — nem o `/api/board`, nem o snapshot de conexão do SSE. Ele existe para **suprimir** o que não mudou, nunca para *responder*. Um board de memória servido sem reler é exatamente o silêncio mentiroso que o push corre o risco de virar (ver **A rede de segurança**).

Houve um kanban com drag-and-drop que gravava `Status:` ao soltar o card. Saiu. Ele nasceu de uma palavra solta na especificação ("kanban"), não de uma necessidade — e ser a única superfície de escrita punha o board em contradição com a própria fronteira que ele defende (ver **Fronteira**, no fim). O `.scratch/` sobe montado **read-only**: a garantia agora é do mount, não da boa intenção.

Se for adicionar recurso, mantenha a propriedade: **nada de estado que não esteja nos `.md`, e nada de escrita.** A única exceção é a largura da gaveta (ver **A gaveta**), que é preferência de quem olha, não conteúdo.

## Rodar

```
docker compose up -d      # http://localhost:7777 (só loopback)
node --test test/         # 94 testes, zero dependências
```

`src/`, `shared/` e `public/` são montados como volume e não há build step — editar e `docker compose restart` basta.

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

Um teste afirma que a string `mtime` não aparece em lugar nenhum do board serializado. **Campo instável no payload mata o push** — vale para qualquer campo novo.

### Dois eventos, e duas supressões independentes

**O board e o arquivo são duas coisas diferentes.** O board projeta `Status:`, título e `Blocked by:` — e **nada do corpo**. Um agente escrevendo a `## Answer` do ticket que você tem aberto na gaveta não move um pixel do board.

Por isso o fio tem dois eventos, e o `sync()` tem duas supressões que **não podem ser colapsadas numa só**:

| evento | quando | o que carrega | quem decide |
| --- | --- | --- | --- |
| `message` | o **board** mudou | o board inteiro (+ `changed`) | o hash do board (`refresh()`) — autoriza **redesenhar a tela** |
| `files` | o **disco** mudou e o board não | **só os caminhos** (~126 bytes) | o digest do conteúdo (`movedFiles()`) — autoriza **avisar quem lê** |

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

- **Varredura de 90s** (`SWEEP_MS`, `src/server.js`) — um `setInterval` que chama o `sync()`, que já relê, já compara e já suprime. Ela é quase de graça **por causa da supressão**: ~40 reconstruções/hora a ~16ms, e na esmagadora maioria das voltas **zero byte no fio e zero re-render** — contra 720 reconstruções *com* 720 re-renders e ~44 MB/hora do polling. É 18× menos trabalho, e devolve ao board a única propriedade que o polling tinha de graça: **ele não consegue ficar em silêncio mentiroso por mais de 90 segundos.**
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
| `src/board.js` | Monta a projeção do `.scratch/` — esforços, issues, arestas de bloqueio. `buildBoard()` é "leia o disco agora": **sem cache dentro**. |
| `src/pads.js` | Os scratchpads de sessão. |
| `src/paths.js` | Os roots (`SCRATCH`, `ARCHIVE`, `PADS`) e a tradução `path`/`ref` (`refOf`). |
| `src/watch.js` | O disco falando: `fs.watch` recursivo, debounce, reopen no `error`. **Só emite.** |
| `src/cache.js` | A supressão: o hash do board (`refresh()`) e o digest por arquivo (`movedFiles()`, `seed()`). |
| `src/server.js` | Só HTTP: rotas, estáticos, SSE, `safePath()`, `sync()` e a varredura. |

O parser **não mora aqui**: ele é `shared/doc.js`, porque o browser também o importa.

`paths.js` existe por uma razão mecânica: se `refOf()` morasse no `server.js`, `board.js` e `pads.js` o importariam de volta — ciclo.

Os três diretórios (`src/`, `shared/`, `public/`) são montados **como diretório**, nunca arquivo a arquivo. O compose já montou `./server.js:/app/server.js`, e o preço apareceu no primeiro módulo novo: os testes passavam no host enquanto o container subia com código velho — ou estourava no import — porque ninguém lembrou de somar o arquivo ao `docker-compose.yml` e ao `Dockerfile`. Módulo novo em `src/` passa a valer sem tocar em nenhum dos dois.

O `shared/` **não** entrou em `src/`, e é deliberado: `src/` é o que só o servidor executa; `shared/` é o que os dois lados importam, e ele é **servido pela HTTP** (`/shared/`). Se essa rota estática cair, o board morre no import e **nenhum teste de unidade percebe** — por isso existe um teste HTTP que a cobre.

## Os módulos do cliente

`public/`, um assunto por arquivo. O `index.html` aponta para um único `<script type="module" src="/app.js">`, e o `app.js` tem **25 linhas**: ele só liga o fio (a gaveta ao documento, o hash ao roteador, o board à tela). **Quase nada mora nele** — se você procura uma função, ela está aqui:

| Módulo | Assunto |
| --- | --- |
| `dom.js` | `el()`, **`svg()`**, `esc()`, `api()`, `toast()`, `copy()`, `copyBtn()` |
| `shell.js` | A moldura: `view`, `crumbs`, `tally`, o indicador de conexão e o botão de reler |
| `state.js` | O board na mão do cliente — um **contêiner mutável**, não um `let` exportado (um binding exportado é cópia viva só para quem já importou) |
| `prompts.js` | `effortPrompts()` / `issuePrompts()` — o comando que destrava cada estado |
| `issues.js` | **Puro**: `cleanTitle`, `numberIndex`, `depsOf`, `openDeps` |
| `graph-layout.js` | **Puro**: `layerize()`, `graphLayout()`, `edgePath()`, `NODE_W/H`, `GAP_X/Y`, `PAD` |
| `graph.js` | O desenho: nós em HTML posicionado, curvas em SVG |
| `overview.js` | A visão geral e os chips de status |
| `effort.js` | A página do esforço: kanban, barra de documentos, viewswitch |
| `pads.js` | Os scratchpads de sessão |
| `drawer.js` | A gaveta: trilha, `wireRefs()`, redimensionamento, e a troca ao vivo |
| `router.js` | O hash decide a tela (`route()`, `refresh()`) e o `EventSource` (`connect()`) |
| `md.js` | O renderer do dialeto `.scratch` (importa `shared/doc.js`) |

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

Todo item da API carrega dois nomes para o mesmo arquivo: `path`, o caminho **dentro do container** (`/workspace/.scratch/...`), por onde o board lê; e `ref`, o caminho **como o workspace o vê** (`.scratch/...`), que é o único que faz sentido colar num agente.

O `ref` é derivado no servidor (`refOf`, em `src/paths.js`), não no cliente: quem sabe qual root montou o quê é o processo que resolveu os roots. `SCRATCH_REF` e `PADS_REF` ajustam o mapeamento se os volumes mudarem.

A regra prática: **o board lê por `path`; o humano copia `ref`.** Um comando com `/workspace/` dentro não leva a lugar nenhum.

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
| `css/components.css` | O que reaparece em mais de uma tela: `.copy`, `.prompt`, `.chip`, `.actionbar`/`button.act`, o botão de reler. |
| `css/kanban.css` | `.board` (flex), `.col`/`.col.is-empty`, `.card`. |
| `css/drawer.css` | O painel: `#scrim`, `#drawer`, `#drawer-grip`, `.drawer-head`, `button.icon`, `#drawer-actions`, `#drawer-body` (incluindo `.swapped` e `.gone`). |
| `css/markdown.css` | O documento renderizado: `#drawer-body.md`, o bloco `.meta`, os alvos do renderer. |
| `css/graph.css` | `.viewswitch`, `.graph`, `.gedge`, `.gnode`. |

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

A página de um esforço tem duas visões, e a escolhida vive no **hash** (`#/<slug>/grafo`) — não em `localStorage`: é onde já vive o resto da navegação, e assim o grafo de um esforço vira um link colável.

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

O grafo não inventa nada: as referências do `Blocked by:` são locais ao esforço, então ele nunca cruza slugs, e um esforço sem nenhuma aresta vira uma coluna só — com uma nota dizendo isso, em vez de fingir um desenho.

## Carimbo de filesystem não é eixo de tempo

Isto está escrito aqui porque **a ideia é atraente e o dado *parece* existir** — sem este parágrafo, alguém vai tentar de novo.

O `birthtime` existe no ext4 e parece a data de criação do ticket. **Ele não é.** O `Write` dos agentes reescreve o arquivo inteiro, o que **cria um inode novo** — e inode novo tem `birthtime` novo. Medido na frota: um ticket `resolved` (escrito, trabalhado e fechado ao longo de dias) tem `birthtime == mtime`, e a **mediana de `Δ birth→mtime` é 0s** em quase todos os esforços — não porque os arquivos nunca mudaram, mas porque a mudança **apagou o rastro de que eles existiam antes**.

Um Gantt construído sobre isso sairia com **barras de duração zero**.

Se o Gantt for um objetivo real, o caminho honesto é **as skills escreverem as datas no `.md`** (`Created:`, `Claimed:`, `Resolved:`): dado que sobrevive à reescrita, é revisável no diff, e é escrito por quem **sabe** (o `/wayfinder` sabe a hora em que reivindicou). Isso é mudança no vocabulário das skills, não no board.

## Os testes

`node --test test/` — **94 testes**, e o projeto não tinha nenhum. `node:test` e `node:assert` são builtin: **a zero-dependência sobreviveu**. Não há `jsdom` e não deve haver — as costuras caem onde o código já é puro, ou onde ele fala HTTP.

| Costura | O que trava |
| --- | --- |
| `test/doc.test.js` | O parser (`shared/doc.js`, puro): os três dialetos, o `Status:` do corpo que **não** vira estado, o `Blocked by:` com prosa, o `summarize()` pulando o preâmbulo, o status desconhecido virando `?`. |
| `test/md.test.js` | O renderer (`md.js`, `string → string`): a **ordem das transformações** e o `Blocked by:` que linka sem engolir a justificativa. |
| `test/graph-layout.test.js` | Os invariantes do grafo (puros): a camada é o **maior** caminho, nenhuma aresta anda para trás, ciclo não estoura, o baricentro, e o guarda que impede o módulo de voltar a tocar o DOM. |
| `test/server.test.js` | **A costura mais alta.** Servidor de verdade em porta efêmera contra um `.scratch/` temporário, stream SSE lido com o `fetch` nativo, **arquivos escritos de verdade no disco**: o push, o debounce, a supressão, o esforço novo que aparece sem restart, o caminho fora do root recusado, os dois eventos (`message` × `files`), e a **segunda escrita atômica** do mesmo arquivo — o teste que o watcher derrubaria, e o que impede alguém de "simplificar" o digest de volta para a lista de caminhos. |
| `test/watch.test.js` | O reopen depois do `error`, e um root que ainda não existe. |
| `test/sweep.test.js` | A varredura de segurança. **Arquivo separado de propósito**: o `cache.js` guarda o hash num módulo, e o `node --test` dá um processo por arquivo — dois servidores no mesmo processo dividiriam o mesmo hash. |
| `test/drawer.test.js` | O que a gaveta **assume sobre o mundo**: que o `changed` fala o mesmo vocabulário de caminho que o board, e que a string do 404 é a que ela procura. |

**Um bom teste aqui exercita comportamento externo, nunca o desenho interno.** "O debounce usa um timer de 120ms" é implementação e quebra na primeira melhoria; "seis escritas seguidas produzem **um** evento" é comportamento, e é esse que está escrito.

Fora de teste, deliberadamente: DOM, CSS, interação da gaveta, arrastar do grafo. Verificados **dirigindo o app de verdade** (chromium por CDP cru, nada instalado), não com um DOM falso.

Duas armadilhas de quem for medir ou testar o push:

- **Zere o disco entre rodadas.** A supressão (corretamente) engole uma segunda escrita idêntica, e isso parece bug.
- **Erro de import de módulo é mudo**: o board simplesmente não monta, e nenhum teste de unidade percebe. É por isso que existe o teste HTTP que busca `/`, `/app.js`, `/md.js`, `/router.js` e `/shared/doc.js`.

## Scratchpads de sessão

`/tmp/claude-0/-root-projetos/<session-id>/scratchpad/` é onde os agentes largam arquivo temporário. O board monta isso em `/workspace/pads` **read-only** e serve em `#/pads`.

É um segundo root, não uma extensão do `.scratch`: `safePath()` prende qualquer caminho vindo do cliente a um dos dois. Rascunho de agente o board lê e não toca — como, aliás, ele não toca em nada.

Os pads **não são vigiados**, e é decisão: eles vivem em `/tmp`, são escritos por toda sessão de agente e mudam muito mais que o `.scratch/`. Vigiar esse churn seria ruído puro. Eles continuam **sob demanda**, buscados quando você entra em `#/pads`. (O `ago()` usa o `mtime` dos *arquivos* de pad, que é coisa diferente do `mtime` de diretório que saiu do board.)

Sessão sem nenhum arquivo é omitida — a maioria nunca escreve nada e listá-las afogaria as poucas com conteúdo. O diretório vive em `/tmp`: some no reboot do WSL, e o board não promete o contrário. Não construa nada que dependa dele persistir.

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
