# SER-582 — Research: показывать codex-сессии (rollout'ы) во вьювере транскриптов

**Тип:** research (без реализации). Документ — результат исследования: формат codex
rollout, устройство вьювера `claude-explorer`, предлагаемая схема URL и план
интеграции с pyphony.

**Мотивация:** [SER-581] — критик-луп ([SER-557]) по умолчанию использует backend
**codex**, а codex не создаёт claude-транскриптов (`wrapper.py:664`:
`transcript_path=""`). Поэтому `_build_transcript_url` (`orchestrator.py:139`) для
codex-критика возвращает `None`, и ссылку на его транскрипт в тред поставить нельзя.
Нужно научить вьювер показывать codex-сессии по `session_id`.

> **NB (2026-07-11):** pyphony уже решил свою часть — билдер `#/codex/<session_id>`
> реализован (SER-581, `f83d94d`) и подставляется в verdict-комментарий критика.
> Осталась только реализация вьювера под этот контракт. Подробнее — §0.5.

---

## 0. TL;DR / выводы

- **Связь надёжная и проверена эмпирически:** `WrapperResult.session_id` (codex
  `thread_id`) **дословно равен** UUID в имени rollout-файла и полю
  `session_meta.id` внутри файла. Значит по одному `session_id` можно однозначно
  найти rollout: glob `~/.codex/sessions/**/rollout-*-<session_id>.jsonl` → ровно
  один файл (проверено на 44 файлах: 0 расхождений, 0 дубликатов).
- **Формат стабилен** между версиями codex (проверено на 0.116 и 0.142.5): JSONL,
  где каждая строка — `{timestamp, type, payload}`. Ключевые типы: `session_meta`,
  `turn_context`, `response_item`, `event_msg`.
- **Рендерить нужно поток `response_item`** (канонический OpenAI-Responses-стрим):
  сообщения (`message` c ролями developer/user/assistant), вызовы инструментов
  (`function_call`/`custom_tool_call`) и их результаты (`*_output`), связываются по
  `call_id`.
- **Ограничение:** reasoning («мышление») в rollout хранится **зашифрованным**
  (`encrypted_content`, `content=null`, `summary=[]`) — читаемый текст размышлений
  недоступен. Ассистентский текст доступен полностью.
- **Схема URL** предлагается workspace-независимой: `/#/codex/<session_id>` (rollout
  не привязан к каталогу проекта, в отличие от claude-транскриптов).
- **Объём работ:** S–M. Во вьювере — новый парсер + роут + API + рендер-ветка
  (переиспользует существующий рендер сообщений/инструментов). В pyphony — маленький
  билдер `_build_codex_transcript_url(...)` и его проброс в комментарии критика и в
  session-started комментарий codex-актора.

---

## 0.5. Статус на момент переоткрытия тикета (2026-07-11, важно)

С момента первого закрытия SER-582 расклад изменился — **pyphony уже реализовал свою
половину плана, а вьювер — ещё нет**. Это и есть причина переоткрытия: критик-ссылки
уже генерируются, но ведут «в никуда».

**Что уже сделано (pyphony, коммит `f83d94d` «feat(SER-581): link critique
transcripts in verdict comments (#83)», 2026-07-11):**

- `_build_codex_transcript_url(base_url, session_id)` — **реализован**
  (`orchestrator.py:157`), возвращает `"{base}/#/codex/{session_id}"`.
- Диспетчер `_build_agent_transcript_url(..., agent, transcript_path, session_id)`
  (`orchestrator.py:174`): `agent=="codex"` → codex-URL, иначе старый
  `_build_transcript_url`.
- `CritiqueRun` (`critique.py:~30`) теперь несёт `agent`, `transcript_path`,
  `session_id` — данные критика для построения ссылки.
- `build_verdict_comment(..., transcript_url=...)` (`critique.py:414`) добавляет
  строку `- Transcript: [{agent}]({transcript_url})` (`critique.py:442-443`).

**Следствие:** verdict-комментарий codex-критика теперь содержит ссылку вида
`http://localhost:3939/#/codex/<session_id>`. То есть **URL-контракт зафиксирован
именно в том виде, что предлагался в этом ресёрче** (`#/codex/<session_id>`) — это
больше не «предложение», а факт, к которому вьювер обязан подстроиться.

**Чего НЕ сделано (вьювер = этот репозиторий):** поддержки codex во вьювере нет
вообще. Проверено: `grep -rin codex server.js parser.js public/index.html` → 0
совпадений. Роутер (`public/index.html:865-876`) знает только
`project`/`session`/`subagent`; ветки `#/codex/...` нет, поэтому такой хэш
**молча проваливается в `else → renderProjectList()`** — пользователь по ссылке
критика видит список проектов, а не транскрипт. Эндпоинтов `/api/codex/*` в
`server.js` тоже нет.

**Итог:** ссылки на codex-транскрипт критика **сейчас нерабочие (мертвые)**.
Оставшаяся работа по SER-582 — чисто на стороне вьювера: реализовать
`#/codex/<session_id>` + `/api/codex/*` + `parseCodexRollout` под уже
зафиксированный контракт (см. §3–§4). pyphony трогать не нужно.

**Повторная эмпирическая проверка (на 50 rollout-файлах, cli 0.142.5):** `session_id`
из имени файла == `session_meta.id` во всех 50 (0 расхождений), 50 уникальных id, 0
коллизий, 0 файлов без meta-id → glob по `session_id` по-прежнему однозначен.
Замечание: сессии, запущенные pyphony через `codex exec`, имеют
`originator="codex_exec"`, `source="exec"` (не `codex_cli_rs`/`cli`), но `id` и
структура строк идентичны — парсер это не затрагивает.

---

## 1. Формат codex rollout JSONL

### 1.1. Расположение и имя файла

```
~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<session_id>.jsonl
```

- Каталоги `YYYY/MM/DD` соответствуют **дате старта** сессии.
- `<session_id>` — UUIDv7-подобный (напр. `019f5110-db64-7800-8df1-1a6831f338be`).

**Проверка связи session_id ↔ файл (эмпирически):**

```
codex exec --json ...  →  {"type":"thread.started","thread_id":"019f5110-db64-7800-8df1-1a6831f338be"}
создан файл:  rollout-2026-07-11T14-04-47-019f5110-db64-7800-8df1-1a6831f338be.jsonl
session_meta.id == 019f5110-db64-7800-8df1-1a6831f338be
```

То есть: `thread.started.thread_id` (это и есть `CodexResult.session_id` →
`WrapperResult.session_id`, см. `codex_runner.py:183`) **==** суффикс имени файла
**==** `session_meta.id`. Скан всех 44 существующих rollout: имя == `session_meta.id`
во всех случаях, коллизий session_id нет.

**Поиск файла по session_id:** рекурсивный glob
`~/.codex/sessions/**/rollout-*-<session_id>.jsonl`. Оптимизация (необязательная):
из имени можно узнать дату и сузить до `YYYY/MM/DD/`, но кол-во файлов невелико —
достаточно полного glob с ранним выходом.

### 1.2. Топология строк

Агрегат по всем rollout (частоты — для понимания веса типов):

| top-level `type`   | `payload.type`                                                                 |
|--------------------|--------------------------------------------------------------------------------|
| `session_meta` (1) | — (метаданные сессии, первая строка)                                           |
| `turn_context` (N) | — (конфиг конкретного «хода»: model, cwd, sandbox, reasoning_effort)            |
| `response_item`    | `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output` |
| `event_msg`        | `task_started`, `task_complete`, `agent_message`, `user_message`, `token_count`, `web_search_end`, `turn_aborted` |

**Два параллельных стрима одного и того же:**
- `response_item` — **канонический** conversation-стрим (формат OpenAI Responses
  API). Самодостаточен для рендера.
- `event_msg` — «UI-события» тонкого клиента: дублируют часть контента в упрощённом
  виде (`agent_message.message` == текст ассистента, `user_message.message` == текст
  юзера), плюс служебное (`token_count.rate_limits`, `task_started/complete`).

**Рекомендация:** рендерить из `response_item`; `event_msg` использовать только как
источник метаданных (напр. usage/rate-limits, границы ходов), чтобы не задваивать
сообщения.

### 1.3. Схемы полезных payload'ов

**`session_meta`** (первая строка):
```json
{ "id": "019f5110-...", "session_id": "019f5110-...", "timestamp": "...",
  "cwd": "/Users/serg-v/pyphony", "originator": "codex_cli_rs",
  "cli_version": "0.142.5", "source": "cli", "model_provider": "openai",
  "base_instructions": { "text": "You are Codex..." } }
```
(в 0.142 добавились `session_id`, `thread_source`; в 0.116 их не было — парсить
устойчиво: `id || session_id`).

**`turn_context`** — конфиг хода:
```json
{ "cwd": "...", "model": "gpt-5.4", "approval_policy": "on-request",
  "sandbox_policy": {"type":"workspace-write", ...}, "reasoning_effort": null,
  "collaboration_mode": {"mode":"default", ...} }
```
Отсюда стоит взять `model` и `reasoning_effort` для шапки транскрипта.

**`response_item / message`** — роли `developer` | `user` | `assistant`:
```json
{ "type":"message", "role":"assistant",
  "content":[{"type":"output_text","text":"..."}] }
```
- `user`/`developer`: блоки `{"type":"input_text","text":...}`.
- `assistant`: блоки `{"type":"output_text","text":...}`.
- Роль `developer` — это системные инъекции (permissions, `<environment_context>`,
  collaboration mode). Их стоит **скрывать/сворачивать** (аналог claude `system`).
- Первый «настоящий» промпт юзера — первый `role:"user"` с осмысленным текстом.

**`response_item / reasoning`** — зашифровано, рендерить нечего:
```json
{ "type":"reasoning", "summary":[], "content":null, "encrypted_content":"gAAAA..." }
```
Во всех наблюдаемых файлах `summary` пуст. **Вывод:** блок reasoning показываем как
свёрнутый плейсхолдер «🧠 reasoning (encrypted)» либо просто скрываем. Если в будущих
версиях `summary` будет непустым — показать его текст.

**Вызовы инструментов** — два семейства, связь по `call_id`:

*function-style (structured args):*
```json
{ "type":"function_call", "name":"exec_command",
  "arguments":"{\"cmd\":\"pwd\",\"workdir\":\"...\"}", "call_id":"call_DLJ..." }
{ "type":"function_call_output", "call_id":"call_DLJ...",
  "output":"Command: /bin/zsh -lc pwd\n...Output:\n/Users/serg-v/pyphony\n" }
```
Имена в данных: `exec_command`, `write_stdin`, `wait`.

*custom-tool-style (freeform input):*
```json
{ "type":"custom_tool_call", "status":"completed", "name":"apply_patch",
  "call_id":"call_tWx...", "input":"*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch\n" }
{ "type":"custom_tool_call_output", "call_id":"call_tWx...",
  "output":"{\"output\":\"Success...\",\"metadata\":{\"exit_code\":0,...}}" }
```
Имена в данных: `exec` (freeform shell, самый частый), `apply_patch`.

**`event_msg / token_count`** — usage/лимиты (в наблюдаемых данных `info:null`,
интересны `rate_limits`); можно опционально показать в шапке.

### 1.4. Отображение на модель сообщений вьювера

Существующая модель вьювера (`parser.js`): `messages[]`, где `assistant` имеет
`blocks[]` (`thinking|text|tool_use`), а `user` имеет `toolResults[]` и `text`.
Codex ложится на неё почти один-к-одному:

| codex                                   | модель вьювера                                   |
|-----------------------------------------|--------------------------------------------------|
| `message role=user` (input_text)        | user-сообщение, `text`                           |
| `message role=assistant` (output_text)  | assistant-сообщение, `blocks:[{type:text}]`      |
| `message role=developer`                | скрыть/свернуть (как `system`)                   |
| `reasoning`                             | `blocks:[{type:thinking, encrypted:true}]` или скрыть |
| `function_call` / `custom_tool_call`    | `blocks:[{type:tool_use, name, input}]`, `id=call_id` |
| `function_call_output`/`custom_tool_call_output` | `toolResults:[{toolUseId:call_id, content:output}]` |

Связывание вызов↔результат — по `call_id` (полный аналог claude `tool_use_id`).
Значит существующий фронтовый рендер tool_use/tool_result переиспользуется без
изменений — нужно только наполнить структуру в парсере.

**Чего у codex нет** (и линки строить не надо): субагентов/Task/Skill —
`#/subagent/...` для codex не применим.

---

## 2. Где живёт вьювер (claude-explorer) и как устроен

Репозиторий: `github.com/volkov/claude-explorer` (этот workspace — его worktree).
Zero-dependency Node.js, слушает `http://localhost:3939`.

- **`server.js`** — HTTP-роутинг. API-эндпоинты (regex по pathname):
  - `GET /api/projects`
  - `GET /api/sessions/<projectDir>`
  - `GET /api/status/<projectDir>/<sessionId>`
  - `GET /api/transcript/<projectDir>/<sessionId>[/subagent/<agentId>]`
  - всё остальное → `public/index.html` (SPA).
- **`parser.js`** — вся файловая логика. Жёстко завязан на
  `CLAUDE_DIR = ~/.claude`, `PROJECTS_DIR = ~/.claude/projects`. Стриминговый парс
  JSONL, LRU-кэш по mtime, `listProjects/listSessions/parseTranscript/…`.
- **`public/index.html`** — SPA + hash-router (`route()` на `hashchange`/`load`):
  ```
  #/                                  → renderProjectList()
  #/project/<projectDir>              → renderSessionList()
  #/session/<projectDir>/<sessionId>  → renderTranscript()
  #/subagent/<projectDir>/<sessionId>/<agentId> → renderSubagent()
  ```
  `renderTranscriptData(...)` рендерит messages/blocks/toolResults + поллинг статуса.

**Важно:** вьювер сейчас полностью «project/session»-центричен. Codex-rollout НЕ
привязан к каталогу проекта, поэтому codex-источник встраивается как **параллельная
ветка**, а не как ещё один «проект».

---

## 3. Предлагаемая схема URL

Поскольку rollout адресуется одним `session_id` (workspace не нужен):

```
#/codex/<session_id>
```

Совместимо с текущим роутером (`parts[0]==='codex' && parts[1]` → новый рендер).
Не конфликтует с `#/session/...` (claude). Опционально можно добавить листинг:

```
#/codex                 → список последних codex-сессий (по желанию)
```

**API (новые эндпоинты в `server.js`):**
```
GET /api/codex/transcript/<session_id>   → распарсенный rollout (та же форма, что claude)
GET /api/codex/status/<session_id>       → { isActive, mtimeMs } (для поллинга «live»)
GET /api/codex/sessions                  → (опц.) список codex-сессий для #/codex
```

Альтернатива, рассмотренная и отклонённая: втиснуть codex в существующую схему
`#/session/<pseudoProject>/<session_id>` с псевдо-проектом вроде `__codex__`. Минус —
перегружает claude-ветку спец-кейсами и требует «фейкового» projectDir в pyphony.
Отдельный namespace `#/codex/...` чище и явнее.

---

## 4. Что менять во вьювере (эскиз)

1. **`parser.js` — новый модуль/функции** (напр. `codex.js` или функции рядом):
   - `CODEX_DIR = ~/.codex/sessions`.
   - `findRolloutBySessionId(sessionId)` — glob `**/rollout-*-<sessionId>.jsonl`
     (валидировать `sessionId` как UUID, чтобы не пускать в glob произвольное).
   - `parseCodexRollout(sessionId)` — стриминговый парс в ту же структуру
     `{sessionMeta, messages, filePath, agentId:null, subagents:[]}`:
     - `session_meta`/`turn_context` → `sessionMeta` (model, cwd, cli_version).
     - `response_item/message` → user/assistant (developer скрывать).
     - `reasoning` → thinking-плейсхолдер (encrypted) либо skip.
     - `function_call`/`custom_tool_call` → tool_use (input: распарсить JSON-строку
       `arguments`, для custom — сырой `input`).
     - `*_output` → tool_result, матч по `call_id`.
   - `getCodexStatus(sessionId)` — mtime rollout-файла (live-поллинг как у claude).
   - LRU-кэш по mtime — переиспользовать существующий механизм.
2. **`server.js`** — 2–3 новых regex-роута (`/api/codex/...`), вызывающих новые
   функции; форма ответа совпадает с claude-транскриптом.
3. **`public/index.html`**:
   - роутер: ветка `parts[0]==='codex'` → `renderCodexTranscript(sessionId)`.
   - `renderCodexTranscript` — по сути `renderTranscript` без projectDir: тянет
     `/api/codex/transcript/<id>`, зовёт `renderTranscriptData`, поллит
     `/api/codex/status/<id>`. Рендер сообщений/инструментов **переиспользуется**.
   - шапка: показать «Codex · model · cli_version», бейдж «codex».
   - (опц.) экран `#/codex` со списком сессий.

Переиспользование рендера — ключевой рычаг: 80% фронта уже есть.

---

## 5. Интеграция с pyphony

> **Обновление (2026-07-11): всё в этом разделе УЖЕ реализовано в pyphony**
> (коммит `f83d94d`, SER-581). Ниже — исходный план, оставлен как описание того,
> что именно было сделано. Действий на стороне pyphony по SER-582 не требуется —
> осталась только реализация вьювера (§4).

### 5.1. Новый билдер ссылки — ✅ реализован (`orchestrator.py:157`)

Рядом с `_build_transcript_url` (`orchestrator.py:139`):

```python
def _build_codex_transcript_url(base_url: str, session_id: str) -> str | None:
    if not session_id:
        return None
    return f"{base_url.rstrip('/')}/#/codex/{session_id}"
```

Данные уже есть в двух местах, менять wrapper не нужно:
- `WrapperResult.session_id` (для критика — `read_wrapper_result(...)`).
- `WrapperAgentInfo.session_id` — wrapper пишет его в `.pyphony-agent.json` по
  приходу session_id (`wrapper.py:605-612`), `transcript_path` остаётся `""`.

### 5.2. Главный кейс SER-581 — ссылка на транскрипт критика — ✅ реализовано

Как это сделано в `f83d94d`:
1. `_default_run_critique` (`orchestrator.py:2420`) теперь возвращает `CritiqueRun`
   (`critique.py:~30`) с полями `text`, `agent`, `transcript_path`, `session_id`.
2. `_post_critique_comment` (`orchestrator.py:2578`) строит URL через диспетчер
   `_build_agent_transcript_url(..., agent, transcript_path, session_id)`
   (`orchestrator.py:174`): `agent=="codex"` → `_build_codex_transcript_url`,
   иначе `_build_transcript_url`.
3. `build_verdict_comment(..., transcript_url=...)` (`critique.py:414`) добавляет
   строку `- Transcript: [{agent}]({transcript_url})` (`critique.py:442-443`).

Это закрывает pyphony-часть SER-581. **Но** для codex URL ведёт на `#/codex/<id>`,
который вьювер пока не рендерит (см. §0.5) — поэтому SER-582 (вьювер) и был
переоткрыт.

### 5.3. Побочный кейс — session-started для codex-актора

`_post_wrapper_transcript_comment` (`orchestrator.py:1974-1993`): для codex сейчас
падает в `_build_session_started_comment` (комментарий **без** ссылки). Можно
достроить: если `transcript_url is None` и есть `agent_info.session_id` → взять
`_build_codex_transcript_url(...)` и вставить ссылку (и, при желании, инструкцию
`codex resume <session_id>` вместо `claude --resume`).

### 5.4. Конфиг

`explorer_base_url` (`models.py:196`, дефолт `http://localhost:3939`) переиспользуется
как есть — хост общий для обеих схем.

---

## 6. Оценка объёма и план

**Оценка оставшейся работы:** S–M (≈0.5–1 день инженера). Фаза 2 (pyphony) уже
сделана в `f83d94d`; осталась только фаза 1 (вьювер).

- ✅ **pyphony** (SER-581, `f83d94d`): билдер ссылки + диспетчер + проброс
  `session_id`/`agent` из критика + строка Transcript в verdict-комментарии — сделано.
- ⬜ **Вьювер** (эта работа): новый парсер codex + роут/эндпоинты + фронт-ветка
  (рендер переиспользуется) — **M**. Это и есть остаток SER-582.

**Оставшиеся фазы:**
1. **Вьювер (закрывает SER-582 и оживляет ссылки SER-581):** `parseCodexRollout`
   (`parser.js`) + `/api/codex/transcript/<id>` и `/api/codex/status/<id>`
   (`server.js`) + ветка `parts[0]==='codex'` → `renderCodexTranscript(sessionId)`
   в роутере (`public/index.html:865`), переиспользующая `renderTranscriptData`
   (`index.html:1021`) и поллинг статуса (`index.html:1454-1492`). Приёмка: открыть
   `#/codex/<реальный session_id>` — видны сообщения, вызовы инструментов и их
   результаты; ссылка из verdict-комментария codex-критика ведёт на живой транскрипт.
2. **(Опц.) session-started для codex-актора** — §5.3, отдельно от главного кейса.

**Точный контракт для вьювера (из §1.4 + текущей модели `parser.js`):**
`parseCodexRollout(sessionId)` должен вернуть тот же объект, что `parseTranscript`:
`{ ...sessionMeta, filePath, messages, subagents:[], agentId:null }`, где
`messages[]` — это `{type:'assistant', blocks:[{type:'text'|'thinking'|'tool_use'}]}`
и `{type:'user', text, toolResults:[{toolUseId, content, isError}]}`. Тогда весь
существующий фронт-рендер (`renderTranscriptData`) заработает без изменений.
Маппинг: `message role=assistant` → assistant.blocks[text]; `role=user` → user.text;
`role=developer` → скрыть; `reasoning` → assistant.blocks[thinking] «(encrypted)» или
skip; `function_call`/`custom_tool_call` → assistant.blocks[tool_use]
(`id=call_id`, `name`, `input`=распарсенный `arguments`/сырой `input`);
`*_output` → user.toolResults[{toolUseId=call_id, content=output}].

**Тесты:** зафиксировать фикстуру rollout в тестах вьювера (парс → ожидаемая
структура messages); ссылку в pyphony уже покрывает SER-581.

---

## 7. Ограничения и открытые вопросы

- **Reasoning зашифрован** — мышление codex во вьювере не покажем (только текст
  ассистента, вызовы инструментов и результаты). Плейсхолдер/скрытие.
- **Resume:** критик всегда стартует свежую сессию (`resume_session_id=None`,
  `orchestrator.py:2172/2194`) → один rollout на раунд, всё однозначно. Для
  resume-сессий актора нужно проверить, дописывает ли codex в тот же файл или создаёт
  новый (для критика неактуально).
- **Расположение `~/.codex`** предполагается дефолтным. Если у codex настроен
  `CODEX_HOME`, путь надо брать оттуда (env). Для текущего сетапа — дефолт.
- **Cross-host:** ссылка ведёт на `localhost:3939`, т.е. полезна только на машине,
  где крутится и codex, и вьювер (как и claude-ссылки сейчас).
- **`event_msg` vs `response_item`:** рендерить из `response_item`, иначе двоятся
  сообщения.

---

## Ссылки на код (актуализировано 2026-07-11)

- Вьювер (этот репозиторий, **codex пока НЕ поддержан**):
  - `server.js:45-100` — API-роуты (regex); добавить `/api/codex/*`.
  - `parser.js:5-6` — `CLAUDE_DIR`/`PROJECTS_DIR` (жёстко на `~/.claude`);
    `parser.js:183` `parseTranscript`, возврат-структура `parser.js:445-451`;
    модель сообщений `parser.js:276-337`.
  - `public/index.html:865-876` роутер (нет ветки `codex`), `:975` `renderTranscript`,
    `:1021` `renderTranscriptData` (переиспользуемый рендер), `:1454-1492` поллинг.
- pyphony (**codex-ссылка УЖЕ реализована**, `f83d94d` / SER-581):
  - `src/pyphony/orchestrator.py:139` `_build_transcript_url` (claude)
  - `src/pyphony/orchestrator.py:157` `_build_codex_transcript_url` ✅ (`#/codex/<id>`)
  - `src/pyphony/orchestrator.py:174` `_build_agent_transcript_url` ✅ (диспетчер по `agent`)
  - `src/pyphony/orchestrator.py:2420` `_default_run_critique` → возвращает `CritiqueRun`
  - `src/pyphony/orchestrator.py:2578` `_post_critique_comment` (строит URL и зовёт билдер)
  - `src/pyphony/critique.py:~30` `CritiqueRun` (`agent`/`transcript_path`/`session_id`)
  - `src/pyphony/critique.py:414` `build_verdict_comment(transcript_url=...)`, строка `:442-443`
  - `src/pyphony/wrapper.py:663-664` codex: пишет `session_id`, `transcript_path=""`
  - `src/pyphony/codex_runner.py:250-255` `thread.started` → `result.session_id`
  - `src/pyphony/models.py:192` `explorer_base_url` (`http://localhost:3939`)

[SER-581]: https://linear.app/serg-v/issue/SER-581
[SER-557]: https://linear.app/serg-v/issue/SER-557
