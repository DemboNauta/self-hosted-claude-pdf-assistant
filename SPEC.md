# self-hosted-claude-pdf-assistant

> Nombre del proyecto (interno y en la interfaz): **PdfClaudeAssistant**
> Repositorio de GitHub: `self-hosted-claude-pdf-assistant`
> Asistente de estudio self-hosted: visor de PDF + Claude (vía sesión de suscripción, no API key) con anotaciones, memoria y repaso espaciado.

---

## 0. Cómo usar este documento (instrucciones para Claude Code)

- Este archivo es la **fuente de verdad** del proyecto. Léelo entero antes de escribir código.
- Trabaja **por fases** (sección 13). No empieces una fase sin que la anterior cumpla sus criterios de aceptación.
- Al empezar, crea un `CLAUDE.md` en la raíz con un resumen de las convenciones (sección 15) y el estado de la fase actual. Actualízalo al terminar cada fase.
- Antes de implementar algo marcado como **[DECISIÓN ABIERTA]** (sección 14), pregúntame.
- Si algo de este documento es técnicamente inviable o hay una alternativa claramente mejor, **dilo antes de implementarlo**, no después.
- Verifica en la documentación oficial actual cualquier detalle del Claude Agent SDK / Claude Code (nombres de opciones, variables de entorno, autenticación): pueden haber cambiado.
- Idioma: **interfaz en español**, código, nombres de variables, commits y comentarios en **inglés**.

---

## 1. Visión

Una web personal, alojada en mi VPS, para **estudiar y aprender a partir de PDFs** con Claude como tutor. Claude ve el documento, responde citando páginas, señala cosas en pantalla como un profesor, subraya, genera resúmenes y exámenes, recuerda qué me cuesta y me propone repasos.

**Usuario:** uno solo (yo). No hay registro, ni multiusuario, ni roles.

> **Actualización 2026-09-26 (decisión del propietario):** la app pasa a ser multiusuario. Cada usuario tiene sus datos aislados y conecta su propia suscripción de Claude con su token; las cuentas las crea el administrador (yo) o se crean con un enlace de invitación de un solo uso. Detalles en `docs/DECISIONS.md`.

**Uso principal:** estudio, aprendizaje e investigación sobre PDFs de todo tipo (apuntes, libros, papers, documentación).

**Dispositivos:** ordenador, tablet y móvil por igual → diseño responsive real, no "adaptado".

---

## 2. Principios de producto

1. **El PDF es el centro.** Claude acompaña, no tapa el documento.
2. **Todo lo que dice Claude es verificable:** cada afirmación sobre el documento lleva cita de página con salto directo.
3. **Claude actúa sobre el documento**, no solo habla: señala, subraya, crea notas y flashcards mediante herramientas.
4. **Memoria destilada, no historial infinito:** se guarda lo importante (preferencias, progreso, conceptos difíciles), no transcripciones completas.
5. **Lo temporal puede volverse permanente:** cualquier señalización efímera de Claude se puede guardar con un clic.
6. **Datos propios y portables:** todo en mi VPS, exportable.

---

## 3. Funcionalidades

Cada funcionalidad tiene un ID para referenciarla en commits, issues y en el roadmap.

### 3.1 Biblioteca

- **F-LIB-01** Jerarquía **Asignatura → Tema → PDFs**. Crear, renombrar, reordenar (drag & drop) y borrar asignaturas y temas.
- **F-LIB-02** Un PDF pertenece a un tema. Se puede mover entre temas.
- **F-LIB-03** Vista de biblioteca con portada (miniatura de la primera página), título, nº de páginas, progreso de lectura (%) y fecha de último acceso.
- **F-LIB-04** "Continuar donde lo dejé": abrir un PDF lo lleva a la última página y posición de scroll.
- **F-LIB-05** Borrado con papelera (recuperable 30 días).

### 3.2 Ingesta de PDFs

- **F-ING-01** Subida arrastrando archivos (uno o varios) a la biblioteca o a un tema concreto.
- **F-ING-02** Importar desde URL (el servidor descarga el PDF; validar content-type y tamaño máximo configurable).
- **F-ING-03** **OCR** automático para PDFs escaneados: detectar páginas sin capa de texto y procesarlas. Idioma OCR por defecto: español + inglés.
- **F-ING-04** Al ingerir: extraer texto por página (con coordenadas), generar miniaturas, indexar para búsqueda.
- **F-ING-05** Estado de procesamiento visible (subiendo → OCR → indexando → listo), en segundo plano, sin bloquear la UI.

### 3.3 Visor de PDF

- **F-VIS-01** Render fiel con selección de texto, zoom, ajuste a ancho/página, navegación por miniaturas y por índice (outline) si el PDF lo tiene.
- **F-VIS-02** Búsqueda dentro del documento.
- **F-VIS-03** Salto a página desde cualquier cita (`p. 12`) con resaltado temporal del fragmento citado.
- **F-VIS-04** Modo oscuro que también invierte/atenúa el lienzo del PDF (opcional, con toggle independiente).
- **F-VIS-05** Seguimiento de progreso: páginas vistas y tiempo de lectura por documento.

### 3.4 Conversación con Claude

- **F-CHAT-01** **Chat lateral** asociado al documento abierto (panel derecho en escritorio, hoja deslizable en móvil).
- **F-CHAT-02** **Preguntar sobre una selección:** al seleccionar texto aparece un menú flotante con acciones: *Preguntar*, *Explícamelo fácil*, *Resumir*, *Hazme una pregunta sobre esto*, *Crear flashcard*, *Subrayar*. La selección (texto + página + posición) viaja como contexto.
- **F-CHAT-03** **Modos de estudio** (botones rápidos en el chat, cada uno es un prompt de sistema/plantilla específico):
  - **Explícamelo fácil:** explicación con analogías, sin jerga, de lo seleccionado o de una sección.
  - **Resumen / esquema:** por documento, capítulo o rango de páginas. Formatos: resumen en prosa, esquema jerárquico, glosario de términos.
  - **Examen:** Claude genera preguntas (test, respuesta corta, desarrollo), evalúa mis respuestas, explica los fallos y registra los conceptos fallados en memoria.
  - **Relacionar:** busca conexiones con otros PDFs de mi biblioteca (misma asignatura primero, luego global) y cita ambos documentos.
  - **Pregunta libre:** texto libre de siempre.
- **F-CHAT-04** **Citas obligatorias:** toda afirmación sobre un documento incluye cita clicable `[Documento, p. N]`. Si la respuesta no está en el documento, Claude lo dice explícitamente.
- **F-CHAT-05** Respuestas en streaming con Markdown, fórmulas (KaTeX) y bloques de código.
- **F-CHAT-06** **Dictado por voz** para escribir preguntas (botón de micrófono en el input).
- **F-CHAT-07** Hilos: cada documento tiene su conversación activa; se puede empezar una nueva. Las conversaciones antiguas se pueden consultar, pero la memoria a largo plazo es la destilada (ver 3.6).
- **F-CHAT-08** Chat a nivel de **tema o asignatura** (preguntas sobre varios PDFs a la vez).
- **F-CHAT-09** **Modo voz:** conversación hablada con Claude, micro siempre abierto. Claude explica con sus palabras y con ejemplos (no lee el PDF tal cual), con voz natural de España (chica o chico); se le puede interrumpir con una pregunta y después sigue donde lo dejó.

### 3.5 Anotaciones y señalización

Hay dos tipos de marcas sobre el PDF:

**A) Señalización efímera de Claude ("puntero de profesor")**

- **F-POINT-01** Mientras explica, Claude puede dibujar sobre el PDF: **flechas, círculos/elipses, recuadros, resaltados y etiquetas de texto**, anclados a una página y a coordenadas o a un fragmento de texto.
- **F-POINT-02** Aparecen con una animación sutil sincronizada con el mensaje que las generó. Se agrupan por mensaje.
- **F-POINT-03** Son **temporales**: desaparecen al enviar el siguiente mensaje o al pulsar "limpiar".
- **F-POINT-04** Cada grupo tiene botón **"Guardar"** que las convierte en anotaciones permanentes (tipo B, autor = Claude).
- **F-POINT-05** Si la marca está en otra página, el visor salta a ella (o muestra un aviso "Claude señala algo en p. N → ir").

**B) Anotaciones permanentes**

- **F-ANN-01** Subrayado/resaltado con **paleta de colores** (mínimo 5 colores, con significado configurable, ej. amarillo = importante, rojo = no entiendo).
- **F-ANN-02** **Notas adhesivas** y comentarios anclados a un punto o a un fragmento.
- **F-ANN-03** **Dibujo a mano alzada** (ratón, dedo, lápiz de tablet con presión si está disponible), con borrador.
- **F-ANN-04** **Subrayado automático por Claude:** acción "Marca las ideas clave" (de una página, capítulo o documento). Usa un color propio de Claude y se distingue visualmente de lo mío. Se puede aceptar o descartar en bloque o una a una.
- **F-ANN-05** Las anotaciones viven en una **capa aparte**, que se puede mostrar/ocultar (filtros: mías / de Claude / por color).
- **F-ANN-06** **Exportar PDF con anotaciones incrustadas** (anotaciones PDF estándar, para que se vean en otros lectores). El original nunca se modifica.
- **F-ANN-07** Panel lateral "Anotaciones": lista de todas las del documento, clicables, filtrables.
- **F-ANN-08** Deshacer/rehacer.

### 3.6 Memoria

- **F-MEM-01** **Memoria global:** mis preferencias y forma de estudiar (ej. "prefiere ejemplos prácticos", "le cuesta la notación matemática", "estudia por las noches").
- **F-MEM-02** **Memoria por documento:** qué he leído, qué he entendido, dudas resueltas, puntos pendientes.
- **F-MEM-03** **Conceptos difíciles:** registro de conceptos que me han costado (vía fallos en exámenes, preguntas repetidas o marcas en rojo), con nivel de dominio.
- **F-MEM-04** Claude escribe en memoria **mediante herramientas** (no automáticamente todo), de forma concisa y sin duplicados. La memoria relevante se inyecta en el contexto de cada sesión.
- **F-MEM-05** **Panel de memoria de solo lectura** ("Lo que Claude sabe de ti"): global, por documento y conceptos difíciles. Sin edición desde la UI.
- **F-MEM-06** No se guardan conversaciones completas como memoria (sí se guardan como historial consultable, F-CHAT-07).

### 3.7 Repaso y progreso

- **F-REV-01** **Flashcards** creadas por mí o por Claude (desde selección, desde un examen o desde conceptos difíciles). Cada tarjeta enlaza a su página de origen.
- **F-REV-02** **Repetición espaciada** con algoritmo FSRS (valoración: Otra vez / Difícil / Bien / Fácil).
- **F-REV-03** **Sesión de repaso diaria propuesta por Claude:** al abrir la app, una tarjeta "Repaso de hoy" con: flashcards pendientes + 1–3 conceptos difíciles para repasar con una mini explicación o pregunta + sugerencia de qué seguir leyendo.
- **F-REV-04** **Estadísticas:** racha de días, tarjetas repasadas, retención, tiempo de estudio, progreso por asignatura/tema/documento, evolución de conceptos difíciles.
- **F-REV-05** Repaso filtrable por asignatura o tema.

### 3.8 Búsqueda global

- **F-SRC-01** Búsqueda de texto completo en todos mis PDFs ("¿dónde hablaba de…?") con resultados por documento y página, fragmento con el término resaltado y salto directo.
- **F-SRC-02** Filtro por asignatura/tema.
- **F-SRC-03** Claude usa esta misma búsqueda como herramienta para el modo *Relacionar*.
- **F-SRC-04** *(Fase posterior)* búsqueda semántica.

### 3.9 Experiencia general

- **F-UX-01** Responsive completo: escritorio, tablet (horizontal y vertical) y móvil.
- **F-UX-02** Modo oscuro (sistema / claro / oscuro).
- **F-UX-03** Atajos de teclado en escritorio (navegación, colores de subrayado, abrir chat, etc.).
- **F-UX-04** Login simple con contraseña (usuario único) y sesión persistente.
- **F-UX-05** Instalable como PWA (icono en la pantalla de inicio del móvil/tablet).

---

## 4. Layout y UX

### Escritorio (≥1024 px)
```
┌──────────┬─────────────────────────────┬──────────────┐
│ Sidebar  │         Visor PDF           │  Panel dcho  │
│ Biblio.  │   (capa anotaciones +       │  Chat |      │
│ Asig→Tema│    capa señalización)       │  Anotaciones │
│          │                             │  | Memoria   │
└──────────┴─────────────────────────────┴──────────────┘
```
Sidebar y panel derecho colapsables y redimensionables.

### Tablet
Visor a pantalla completa; chat como panel lateral superpuesto; barra de herramientas de dibujo flotante (optimizada para lápiz).

### Móvil
Visor a pantalla completa; chat como **bottom sheet** (medio / completo); barra inferior: Biblioteca · Leer · Chat · Repaso. El menú de selección de texto debe ser usable con el dedo.

### Pantallas
1. Login
2. Inicio: "Repaso de hoy" + continuar leyendo + estadísticas breves
3. Biblioteca (Asignaturas → Temas → PDFs)
4. Lector (visor + chat + anotaciones)
5. Repaso (flashcards)
6. Estadísticas
7. Memoria (solo lectura)
8. Ajustes (colores de subrayado, tema, idioma OCR, exportación/backup)

**Estilo visual:** [DECISIÓN ABIERTA] — por defecto, minimalista y tipográfico, cómodo para leer horas.

---

## 5. Arquitectura

### Stack propuesto (ajustable, justifícame cambios)

| Capa | Tecnología |
|---|---|
| Frontend | React + TypeScript + Vite, Tailwind CSS |
| Visor PDF | `pdfjs-dist` (PDF.js) con capa de texto propia |
| Capas de dibujo | SVG superpuesto por página (coordenadas en espacio PDF, no píxeles) |
| Estado | Zustand o TanStack Query (servidor) |
| Backend | Node.js + TypeScript (Fastify) |
| Claude | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) autenticado con **mi suscripción** (nunca API key) |
| Tiempo real | WebSocket (o SSE) para streaming del chat y eventos de herramientas |
| Base de datos | SQLite (`better-sqlite3`) + Drizzle ORM, **FTS5** para búsqueda |
| Ficheros | Sistema de archivos del VPS (`/data/pdfs/…`) |
| OCR | `ocrmypdf` (Tesseract) en un worker/cola en segundo plano |
| Exportar anotaciones | `pdf-lib` |
| Repetición espaciada | `ts-fsrs` |
| Fórmulas | KaTeX |
| Voz | Web Speech API en el navegador (fallback: aviso si no está soportada) |
| Despliegue | Docker Compose + Caddy (HTTPS automático) |

### Diagrama
```
Navegador (React)
   │  HTTPS / WebSocket
   ▼
Caddy ──► Backend Fastify ──► SQLite (+FTS5)
              │     │
              │     └──► /data (PDFs, miniaturas, exportaciones)
              │
              ├──► Worker de ingesta (texto, OCR, miniaturas, índice)
              │
              └──► Claude Agent SDK ──► Claude Code ──► Claude (sesión de MI suscripción, sin API)
                        │
                        └── MCP server in-process con las herramientas de la app (sección 7)
```

---

## 6. Integración con Claude (vía sesión de suscripción, NUNCA vía API)

### 6.1 Requisito no negociable: suscripción, no API

> **Claude funciona exclusivamente con mi propia suscripción de Claude (Pro/Max), igual que cuando uso Claude Code en mi terminal. Está PROHIBIDO usar la API de Anthropic con API key de pago por uso.**

Esto implica:

- **No** usar `@anthropic-ai/sdk` ni llamadas directas a `api.anthropic.com/v1/messages`.
- **No** existe la variable `ANTHROPIC_API_KEY` en el proyecto: ni en `.env.example`, ni en Docker, ni en el código. Claude Code da prioridad a una API key si la encuentra en el entorno, así que su presencia rompería el requisito sin avisar.
- El backend usa el **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), que ejecuta Claude Code por debajo con la sesión de mi suscripción.
- Uso estrictamente personal (un usuario, yo), que es el caso compatible con usar la suscripción.
- **Verificar en la documentación oficial actual** los nombres exactos de comandos y variables, pueden haber cambiado.

### 6.2 Cómo se inicia sesión (soportar ambas formas)

1. **Token de larga duración (recomendada):** en cualquier máquina con Claude Code ejecuto `claude setup-token`, inicio sesión con mi cuenta y obtengo un token OAuth. Lo pongo en el `.env` del VPS como `CLAUDE_CODE_OAUTH_TOKEN`.
2. **Login interactivo en el contenedor:** `docker compose exec server claude` → `/login` con mi cuenta. Las credenciales se guardan en `~/.claude` del contenedor, que debe ser un **volumen persistente** (`./data/claude-home`) para sobrevivir a reinicios y actualizaciones.

Documentar ambos métodos paso a paso en el README.

### 6.3 Comprobaciones de seguridad del modo de autenticación

- **Al arrancar el servidor:** si `ANTHROPIC_API_KEY` (o `ANTHROPIC_AUTH_TOKEN`) está definida en el entorno, **el servidor se niega a arrancar** con un error claro: "Este proyecto solo funciona con suscripción. Elimina ANTHROPIC_API_KEY".
- Al lanzar el proceso de Claude Code desde el SDK, pasar un entorno **filtrado** que elimine explícitamente cualquier variable de API key, por si acaso.
- **Health check de Claude:** endpoint `GET /claude/status` que hace una consulta mínima y devuelve si la sesión es válida y el método de autenticación detectado (token OAuth / login interactivo).
- **Ajustes → "Conexión con Claude":** muestra el estado (conectado con suscripción / sesión caducada / límite de uso alcanzado) y, si ha caducado, las instrucciones para renovarla.
- Test automatizado que falle si aparece `ANTHROPIC_API_KEY` o `api.anthropic.com` en el código fuente o en la configuración.

### 6.4 Funcionamiento del agente
- **Sesiones:** una sesión de Claude por hilo de conversación. Guardar el `session_id` en la base de datos y **reanudar** la sesión al volver al documento para conservar el contexto.
- **Contexto que se inyecta en cada sesión** (system prompt / append):
  - Rol: tutor de estudio en español, conciso, que cita páginas siempre.
  - Documento activo (id, título, nº de páginas, índice) y página actual del visor.
  - Selección actual (texto, página, bbox) si la hay.
  - Memoria global + memoria del documento + top conceptos difíciles relacionados.
  - Instrucciones del modo de estudio elegido.
- **El contenido del PDF no se mete entero en el prompt:** Claude lo lee bajo demanda con herramientas (`get_pages`, `get_page_image`, `search_library`).
- **Sandbox y permisos (crítico):**
  - Deshabilitar herramientas de sistema de Claude Code: **sin Bash, sin Write/Edit, sin WebFetch** para el agente de estudio. Solo las herramientas MCP de la app (`allowedTools` explícito).
  - `cwd` en un directorio vacío y aislado.
  - Modo de permisos que no pida confirmaciones interactivas, pero limitado a la lista blanca.
- **Streaming:** reenviar al frontend por WebSocket los tokens de texto y los eventos de herramientas (para dibujar señalizaciones en tiempo real).
- **Errores y límites:** si la suscripción alcanza su límite de uso o el token caduca, mostrar un mensaje claro en la UI (no un error genérico).
- **Modelo:** configurable en Ajustes.

---

## 7. Herramientas MCP (in-process) que Claude puede usar

Definidas con el helper de MCP del Agent SDK. Todas validan entrada con Zod. Las que modifican la vista emiten un evento al frontend.

### Lectura
| Tool | Entrada | Salida |
|---|---|---|
| `get_document_info` | `docId` | título, páginas, índice, asignatura/tema |
| `get_pages` | `docId, fromPage, toPage` | texto por página (limitar a ~10 páginas por llamada) |
| `get_page_image` | `docId, page` | imagen renderizada de la página (para figuras, fórmulas, diagramas) |
| `search_library` | `query, scope? (doc/topic/subject/all)` | resultados `{docId, title, page, snippet}` |
| `list_library` | `scope?` | árbol asignaturas → temas → documentos |

### Señalización efímera (F-POINT)
| Tool | Entrada |
|---|---|
| `point_at` | `docId, page, shapes[]` donde cada shape es `{type: arrow|circle|rect|highlight|label, anchor, style?, label?}` |
| `clear_pointers` | — |

`anchor` puede ser:
- `{ kind: "text", quote: "texto exacto", occurrence?: n }` → el frontend localiza el texto en la capa de texto de esa página (preferido, robusto).
- `{ kind: "rect", x, y, w, h }` en coordenadas normalizadas 0–1 de la página (para figuras).

### Anotaciones permanentes (F-ANN)
| Tool | Entrada |
|---|---|
| `highlight_key_ideas` | `docId, highlights[] {page, quote, reason}` → se crean como **propuestas** pendientes de aceptar |
| `add_note` | `docId, page, anchor, text` |

### Memoria (F-MEM)
| Tool | Entrada |
|---|---|
| `remember` | `scope: global|document, docId?, content, category` (evitar duplicados: el backend compara con lo existente) |
| `mark_concept_difficult` | `concept, docId?, page?, evidence` |
| `update_concept_mastery` | `conceptId, delta, evidence` |
| `update_progress` | `docId, note` (qué se ha cubierto) |

### Repaso (F-REV)
| Tool | Entrada |
|---|---|
| `create_flashcards` | `cards[] {front, back, docId, page}` → propuestas para aceptar |
| `record_exam_result` | `docId, question, userAnswer, correct, concepts[]` |

### Citas
Las citas van en el texto con un formato parseable por el frontend, p. ej. `[[cite:docId:page|"fragmento opcional"]]`, que se renderiza como chip clicable `Título, p. N`. Documentar el formato en el system prompt.

---

## 8. Modelo de datos (orientativo)

```
subjects        (id, name, color, order, created_at)
topics          (id, subject_id, name, order, created_at)
documents       (id, topic_id, title, file_path, page_count, has_ocr, status,
                 source_url, last_page, last_scroll, progress_pct,
                 created_at, last_opened_at, deleted_at)
pages           (id, document_id, page_number, text, text_layer_json, thumbnail_path)
pages_fts       (FTS5 sobre pages.text, con document_id y page_number)

annotations     (id, document_id, page, type[highlight|note|drawing|shape],
                 author[user|claude], status[active|proposed|rejected],
                 color, anchor_json, content, created_at, updated_at)

threads         (id, document_id?, topic_id?, subject_id?, claude_session_id,
                 title, created_at, updated_at)
messages        (id, thread_id, role, content, tool_events_json, created_at)

memory_items    (id, scope[global|document], document_id?, category, content,
                 created_at, updated_at)
concepts        (id, name, document_id?, page?, mastery[0..1], times_failed,
                 last_seen_at, created_at)

flashcards      (id, document_id?, page?, concept_id?, front, back,
                 author[user|claude], status[active|proposed], fsrs_state_json,
                 due_at, created_at)
reviews         (id, flashcard_id, rating, reviewed_at)
study_sessions  (id, document_id?, started_at, ended_at, pages_viewed)
settings        (key, value)
```

Coordenadas de anotaciones siempre en **espacio de página normalizado** (independiente del zoom y del dispositivo).

---

## 9. API y eventos

### REST (resumen)
- `POST /auth/login`, `POST /auth/logout`
- CRUD `/subjects`, `/topics`, `/documents`, `/annotations`, `/flashcards`
- `POST /documents/upload`, `POST /documents/import-url`
- `GET /documents/:id/file`, `GET /documents/:id/export-annotated`
- `GET /search?q=&scope=`
- `GET /memory`, `GET /concepts`
- `GET /review/today`, `POST /flashcards/:id/review`
- `GET /stats`

### WebSocket `/ws/chat`
Cliente → servidor:
```json
{ "type": "user_message", "threadId": "...", "text": "...",
  "mode": "free|eli5|summary|exam|relate",
  "context": { "docId": "...", "currentPage": 12,
               "selection": { "page": 12, "text": "...", "rects": [...] } } }
```
Servidor → cliente:
- `assistant_delta` (texto en streaming)
- `tool_event` (`point_at`, `clear_pointers`, `highlight_proposals`, `flashcard_proposals`, `memory_updated`…)
- `assistant_done`
- `error` (con tipo: `rate_limited`, `auth_expired`, `internal`)

---

## 10. Estructura del repositorio

```
self-hosted-claude-pdf-assistant/
├── CLAUDE.md
├── SPEC.md                  ← este documento
├── docker-compose.yml
├── Caddyfile
├── .env.example
├── apps/
│   ├── web/                 ← React + Vite
│   │   └── src/
│   │       ├── features/{library,reader,chat,annotations,pointer,review,stats,memory,settings}
│   │       ├── components/
│   │       └── lib/
│   └── server/              ← Fastify
│       └── src/
│           ├── routes/
│           ├── claude/      ← agent SDK, system prompts, sesiones
│           ├── tools/       ← herramientas MCP
│           ├── ingest/      ← extracción, OCR, miniaturas, indexado
│           ├── db/          ← esquema Drizzle + migraciones
│           └── services/
├── packages/
│   └── shared/              ← tipos compartidos (eventos WS, anchors, DTOs)
└── data/                    ← volumen (gitignored)
```

Monorepo con pnpm workspaces. Paquetes con el nombre interno: `@pdfclaudeassistant/web`, `@pdfclaudeassistant/server`, `@pdfclaudeassistant/shared`.

---

## 11. Despliegue en el VPS

- `docker compose up -d` levanta: `server` (incluye worker de ingesta, `ocrmypdf` y Claude Code), `web` (estático servido por Caddy) y `caddy`.
- Variables de entorno (`.env.example`): `APP_PASSWORD_HASH`, `SESSION_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN` (opcional si se usa login interactivo), `DOMAIN`, `MAX_UPLOAD_MB`, `OCR_LANGS=spa+eng`, `CLAUDE_MODEL`. **Nunca `ANTHROPIC_API_KEY`.**
- Volúmenes persistentes: `./data` (PDFs, SQLite, miniaturas) y `./data/claude-home` (credenciales de la sesión de Claude Code).
- Claude Code instalado dentro de la imagen del `server`.
- **Backup:** script que exporta SQLite + PDFs a un `.tar.gz` fechado; botón en Ajustes para descargarlo.
- Documentar en el README el paso de generar el token de Claude en el VPS.

---

## 12. Seguridad

- HTTPS obligatorio (Caddy).
- Login con contraseña (hash argon2/bcrypt), cookie de sesión `httpOnly`, `secure`, `sameSite=strict`. Rate limiting en login.
- El agente de Claude **sin acceso a shell ni a escritura de archivos**; solo herramientas de la app.
- El texto de los PDFs es **dato, no instrucciones**: el system prompt debe indicar a Claude que ignore instrucciones contenidas en los documentos (prompt injection).
- Importación por URL: bloquear IPs privadas/locales (SSRF), límite de tamaño, validar que es PDF.
- El token/sesión de Claude nunca llega al frontend y `./data/claude-home` no se incluye en los backups descargables.
- Ninguna API key de Anthropic en el proyecto (ver 6.3).

---

## 13. Roadmap por fases

### Fase 0 — Esqueleto
Monorepo, Docker Compose, Caddy, login, SQLite + migraciones, CI básico (lint + typecheck + tests).
Integración mínima con Claude vía suscripción (6.1–6.3) incluida aquí.
**Aceptación:** despliego en el VPS, accedo por HTTPS, hago login, y `GET /claude/status` confirma que Claude responde usando mi suscripción. Si pongo `ANTHROPIC_API_KEY` en el entorno, el servidor no arranca.

### Fase 1 — V1: leer y preguntar
F-LIB-01..04, F-ING-01, F-ING-04, F-ING-05, F-VIS-01..03, F-CHAT-01, F-CHAT-02, F-CHAT-04, F-CHAT-05, F-CHAT-07, F-ANN-01, F-ANN-02, F-ANN-05, F-ANN-07, F-UX-01, F-UX-02, F-UX-04. Herramientas: `get_document_info`, `get_pages`, `search_library` (solo doc).
**Aceptación:** subo un PDF a Asignatura → Tema, lo leo en móvil y escritorio, selecciono un párrafo y pregunto, Claude responde en streaming con citas que saltan a la página correcta, y puedo subrayar y poner notas que persisten.

### Fase 2 — V2: Claude actúa sobre el PDF + memoria
F-POINT-01..05, F-ANN-03, F-ANN-04, F-ANN-06, F-ANN-08, F-CHAT-03 (todos los modos), F-MEM-01..06, F-ING-02, F-ING-03, F-VIS-04, F-VIS-05. Herramientas de señalización, anotación, memoria, `get_page_image`.
**Aceptación:** Claude me explica un diagrama señalándolo con flechas, guardo esas marcas, le pido las ideas clave y acepto sus subrayados, hago un examen y los fallos aparecen en "conceptos difíciles" del panel de memoria. Un PDF escaneado se vuelve buscable.

### Fase 3 — V3: repaso, búsqueda global y voz
F-REV-01..05, F-SRC-01..03, F-CHAT-06, F-CHAT-08, F-LIB-05, F-UX-03, F-UX-05. Herramientas de flashcards y exámenes.
**Aceptación:** al abrir la app veo "Repaso de hoy" con tarjetas FSRS y conceptos a reforzar, busco un término en toda la biblioteca, pregunto por voz y el modo *Relacionar* cita dos documentos distintos.

### Fase 4 — Mejoras
Búsqueda semántica (F-SRC-04), estadísticas avanzadas, exportación de notas/resúmenes a Markdown, pulido visual.

---

## 14. Decisiones abiertas

1. **Estilo visual** (minimalista tipográfico por defecto / tipo libro / tipo Notion).
2. **Colores de subrayado** y su significado por defecto.
3. **Idioma de respuesta de Claude:** siempre español, o el idioma del documento.
4. **Búsqueda semántica:** embeddings locales en el VPS o prescindir de ella.
5. **Voz:** Web Speech API (depende del navegador) o transcripción en servidor (Whisper local) si no funciona bien en mis dispositivos.
6. **Tamaño máximo de PDF** y comportamiento con libros muy largos (500+ páginas).
7. **Límite de uso de la suscripción:** ¿mostrar un contador aproximado de uso? (La app consume de mis mismos límites que Claude Code y claude.ai.)

---

## 15. Convenciones

- **Nombres:** el nombre interno **PdfClaudeAssistant** se usa en código y configuración (paquetes `@pdfclaudeassistant/*`, servicios y red de Docker `pdfclaudeassistant-*`, base de datos `pdfclaudeassistant.db`, prefijo de logs `[PdfClaudeAssistant]`, cookie `pdfclaudeassistant_session`). Es también el nombre que se muestra en la interfaz. El repositorio se llama `self-hosted-claude-pdf-assistant`.

- TypeScript estricto en todo el proyecto. Sin `any` salvo justificado.
- Tipos compartidos entre front y back en `packages/shared` (eventos WS, anchors, DTOs).
- Validación con Zod en todas las entradas (REST, WS y herramientas MCP).
- Commits convencionales en inglés (`feat(reader): ...`), referenciando IDs de funcionalidad (`F-ANN-01`).
- Tests: unitarios para servicios (FSRS, anclaje de texto, parseo de citas) y al menos un test end-to-end (Playwright) por criterio de aceptación de fase.
- Accesibilidad: navegable con teclado, contrastes AA, `aria-labels` en iconos.
- Rendimiento: virtualizar páginas del visor (renderizar solo las visibles ± 2) para PDFs largos.
- Textos de la UI centralizados (preparado para i18n, aunque solo haya español).
