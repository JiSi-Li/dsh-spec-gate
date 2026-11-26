/**
 * dsh-spec-gate —— 宿主半端
 * ---------------------------------------------------------------------------
 * 五阶段硬闸门：SPEC → PLAN → EXECUTE → VERIFY → ACCEPT
 *
 * 硬的部分只做三件事（其余都是 UI）：
 *   1. `ctx.tools.guard()` 同步拒绝 write/edit/pwsh —— 与注册顺序无关（D4）；
 *   2. 状态只由 HTTP 路由改，路由要 `sec-fetch-site: same-origin`（D2 按钮才生效）；
 *   3. 每次拒绝落审计，tab 里看得到（D8）。
 *
 * 已知缺口（写进 README）：pwsh 只能按命令文本启发式判断，
 * `python -c "..."` 这类绕得过去；要真封死只能整个禁 shell。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'spec-gate'
export const inject = ['webServer', 'tools']

const STAGES = ['SPEC', 'PLAN', 'EXECUTE', 'VERIFY', 'ACCEPT']
const ARTIFACT = { SPEC: 'SPEC.md', PLAN: 'PLAN.md', EXECUTE: 'RUN.md', VERIFY: 'VERIFY.md', ACCEPT: 'ACCEPT.md' }

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'spec-gate')
const TASKS_FILE = join(STATE_DIR, 'tasks.json')
const HISTORY_FILE = join(STATE_DIR, 'history.jsonl')
const DEBUG_FILE = join(STATE_DIR, 'debug.jsonl')

const now = () => new Date().toISOString()
const emptyGates = () => Object.fromEntries(STAGES.map((s) => [s, { status: 'pending', at: null, quote: null }]))

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }) } catch { /* 已存在 */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  try { writeFileSync(tmp, '') } catch { /* 忽略 */ }
}
function appendJsonl(file, row) {
  ensureDir(dirname(file))
  try { appendFileSync(file, JSON.stringify(row) + '\n', 'utf8') } catch { /* 审计不能拖垮工具 */ }
}
function db() {
  const d = readJson(TASKS_FILE, null)
  if (!d || typeof d !== 'object') return { version: 1, task: null }
  if (!d.task) return { version: 1, task: null }
  return d
}
function save(d) { writeJson(TASKS_FILE, d) }

/** 活跃任务；只有 status === 'active' 才算 */
function activeTask(d) {
  const t = d.task
  return t && t.status === 'active' ? t : null
}

function event(t, kind, detail) {
  const row = { at: now(), kind, detail }
  t.history.push(row)
  if (t.history.length > 200) t.history.splice(0, t.history.length - 200)
  appendJsonl(HISTORY_FILE, { ...row, slug: t.slug })
}

/** 把状态写成 PROJECT/.specs/<slug>/STATE.md（人可读的权威镜像） */
function writeStateMd(t) {
  const rows = STAGES.map((s) => {
    const g = t.gates[s] || { status: 'pending' }
    const quote = g.quote ? g.quote.replace(/\|/g, '\\|') : '—'
    return `| ${s} | ${g.status} | ${quote} | ${g.at || '—'} | ${g.scope || '—'} |`
  })
  const denials = (t.denials || []).slice(-20).map((d) => `- ${d.at} · ${d.tool} · ${String(d.summary || '').slice(0, 200)}`)
  const hist = (t.history || []).slice(-20).map((h) => `- ${h.at} · ${h.kind} · ${String(h.detail || '').slice(0, 200)}`)
  const md = [
    `# STATE — ${t.title}`,
    '',
    `- 任务：\`${t.slug}\`　状态：**${t.status}**　当前阶段：**${t.stage}**`,
    `- 目录：\`${t.dir}\`　创建：${t.createdAt}`,
    t.awaiting ? `- 待确认：**${t.awaiting.stage}** —— ${t.awaiting.summary}` : '- 待确认：无',
    '',
    '## 阶段',
    '',
    '| 阶段 | 状态 | 用户确认原话 | 时间 | 授权范围 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 被拒记录（最近 20 条）',
    '',
    denials.length ? denials.join('\n') : '- 无',
    '',
    '## 事件（最近 20 条）',
    '',
    hist.length ? hist.join('\n') : '- 无',
    '',
  ].join('\n')
  try {
    ensureDir(join(t.dir, '.specs', t.slug))
    writeFileSync(join(t.dir, '.specs', t.slug, 'STATE.md'), md, 'utf8')
  } catch { /* 目录不可写时也不炸 */ }
}

function slugify(input) {
  const s = String(input || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'task-' + Date.now().toString(36)
}

function toolName(exec) {
  return String(exec?.name ?? exec?.toolName ?? exec?.definition?.name ?? exec?.tool?.name ?? exec?.id ?? '')
}
function toolArgs(exec) {
  return exec?.args ?? exec?.arguments ?? exec?.input ?? exec?.parameters ?? {}
}
function sessionOf(exec) {
  return String(
    exec?.sessionId ?? exec?.session?.id ?? exec?.agent?.sessionId ??
    exec?.agent?.session?.id ?? exec?.agent?.id ?? '',
  )
}

const WRITE_TOOLS = new Set(['write', 'edit', 'fs_write', 'fs_edit', 'apply_patch'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'shell_command', 'exec'])
const WRITE_CMD = /(^|[^\w])(set-content|add-content|out-file|new-item|copy-item|move-item|remove-item|rename-item|\brm\b|\bdel\b|mkdir|touch|tee\b|(?<![-\w=])>\s*[^\s|>&]|(?<![-\w=])>>|sed\s+-i|python\s+-c|node\s+-e|git\s+(commit|checkout|reset|apply|stash))/i

function underSpecs(t, abs) {
  const root = join(t.dir, '.specs') + sep
  return abs.toLowerCase().startsWith(root.toLowerCase())
}

/**
 * 注册一个工具。不依赖 defineTool（桌面 profile 装不到 @deepseek-ai/dsh-tools），
 * 直接用 registry 认的形状：{ name, description, parameters, output:{schema,render}, execute }。
 */
function makeTool(ctx, spec) {
  return ctx.tools.register({
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.parameters || {}, additionalProperties: true },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        let text
        try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { text = String(value) }
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) { return spec.execute(args || {}, exec || {}) },
  })
}

function stateSnapshot(t) {
  if (!t) return { active: false, task: null }
  return {
    active: t.status === 'active',
    task: {
      slug: t.slug,
      title: t.title,
      dir: t.dir,
      stage: t.stage,
      status: t.status,
      createdAt: t.createdAt,
      gates: t.gates,
      awaiting: t.awaiting || null,
      denials: (t.denials || []).slice(-10),
      history: (t.history || []).slice(-15),
      artifacts: ARTIFACT,
    },
  }
}

function bootLog(line) {
  try {
    ensureDir(STATE_DIR)
    appendFileSync(join(STATE_DIR, 'boot.log'), `${now()} [${process.pid}] ${line}\n`)
  } catch { /* 日志写不进去不影响功能 */ }
}

export function apply(ctx) {
  /* ---------------- 1. 工具 ---------------- */

  const disposers = []

  bootLog(`apply() 开始，inject=${inject.join(',')}`)

  disposers.push(makeTool(ctx, {
    name: 'spec_start',
    description: '开始一个规格驱动任务（只有用户明确说「开工GO」或同意后才调用）。创建 .specs/<slug>/STATE.md，进入 SPEC 阶段；此后写代码会被闸门拒绝，直到用户在本标签页逐阶段确认。',
    parameters: {
      title: { type: 'string', description: '任务标题，一句话' },
      slug: { type: 'string', description: '目录名（可省略，默认由标题生成）' },
      dir: { type: 'string', description: '任务所属工作区绝对路径（可省略，默认当前工作目录）' },
    },
    async execute(args, exec) {
      const d = db()
      const cur = activeTask(d)
      if (cur) return { ok: false, error: `已有活跃任务 ${cur.slug}（${cur.stage}），先在标签页取消或确认它，或调 spec_abort。` }
      const rawDir = args.dir || exec.cwd || exec.workingDirectory || (exec.session && exec.session.cwd)
      if (!rawDir) return { ok: false, error: '没拿到工作目录：请显式传 dir（任务所属工作区的绝对路径），不要让它退回宿主进程的目录。' }
      const dir = resolve(String(rawDir))
      const slug = slugify(args.slug || args.title)
      const t = {
        slug,
        title: String(args.title || slug),
        dir,
        sessionId: sessionOf(exec) || null,
        createdAt: now(),
        stage: 'SPEC',
        status: 'active',
        gates: emptyGates(),
        awaiting: null,
        denials: [],
        history: [],
      }
      event(t, 'start', `任务创建于 ${dir}`)
      d.task = t
      save(d)
      writeStateMd(t)
      return {
        ok: true,
        slug,
        stage: 'SPEC',
        dir,
        next: '写 SPEC.md（用 spec_write，file=SPEC.md），然后调用 spec_ask_confirm 让用户在标签页确认。',
      }
    },
  }))

  disposers.push(makeTool(ctx, {
    name: 'spec_write',
    description: '写当前阶段的产物文件（SPEC.md / PLAN.md / RUN.md / VERIFY.md / ACCEPT.md）到 .specs/<slug>/。只能写当前阶段的那一个文件；上一阶段没确认就写会被拒。',
    parameters: {
      file: { type: 'string', description: '文件名，例如 SPEC.md' },
      content: { type: 'string', description: '文件全文（覆盖写）' },
    },
    async execute(args) {
      const d = db()
      const t = activeTask(d)
      if (!t) return { ok: false, error: '没有活跃任务；先说「开工GO」让我建任务。' }
      const expect = ARTIFACT[t.stage]
      const file = String(args.file || expect)
      if (file !== expect) {
        return { ok: false, error: `当前阶段是 ${t.stage}，只能写 ${expect}，不能写 ${file}。` }
      }
      if (t.awaiting) {
        return { ok: false, error: `${t.stage} 已提交待用户确认，正在等按钮；要改内容先 spec_abort 或等用户驳回。` }
      }
      ensureDir(join(t.dir, '.specs', t.slug))
      writeFileSync(join(t.dir, '.specs', t.slug, file), String(args.content || ''), 'utf8')
      event(t, 'artifact', `写入 ${file}（${String(args.content || '').length} 字符）`)
      save(d)
      writeStateMd(t)
      return { ok: true, file, stage: t.stage }
    },
  }))

  disposers.push(makeTool(ctx, {
    name: 'spec_ask_confirm',
    description: '把当前阶段提交给用户确认：只在标签页里发一张卡片，把状态置为「待确认」。你无法自己确认——确认必须由用户在标签页点按钮。',
    parameters: {
      summary: { type: 'string', description: '一句话说清这次要用户确认什么（显示在卡片上）' },
    },
    async execute(args) {
      const d = db()
      const t = activeTask(d)
      if (!t) return { ok: false, error: '没有活跃任务。' }
      t.awaiting = { stage: t.stage, summary: String(args.summary || ''), at: now() }
      event(t, 'ask', `待确认：${t.stage} — ${args.summary || ''}`)
      save(d)
      writeStateMd(t)
      return { ok: true, stage: t.stage, waiting: true, hint: '现在等用户在标签页点「确认」，不要自己往下走。' }
    },
  }))

  disposers.push(makeTool(ctx, {
    name: 'spec_state',
    description: '读当前规格任务的状态：阶段、每个阶段的确认状态与时间、待确认卡片、最近的被拒记录与事件。',
    parameters: {},
    async execute() {
      const d = db()
      return stateSnapshot(d.task)
    },
  }))

  disposers.push(makeTool(ctx, {
    name: 'spec_abort',
    description: '取消当前规格任务（不删产物）。取消后闸门立即解除，标签页消失。',
    parameters: { reason: { type: 'string', description: '取消原因（可选）' } },
    async execute(args) {
      const d = db()
      const t = d.task
      if (!t) return { ok: false, error: '没有任务。' }
      t.status = 'cancelled'
      t.awaiting = null
      event(t, 'abort', String(args.reason || '用户取消'))
      save(d)
      writeStateMd(t)
      return { ok: true, slug: t.slug, status: 'cancelled' }
    },
  }))

  /* ---------------- 2. 硬闸门 ---------------- */

  disposers.push(ctx.tools.guard((exec) => {
    let d = null
    let t = null
    try {
      d = db()
      t = activeTask(d)
    } catch (e) {
      appendJsonl(DEBUG_FILE, { at: now(), where: 'guard/load', error: String(e && e.message) })
      return undefined
    }
    if (!t) return undefined

    const tool = toolName(exec)
    const args = toolArgs(exec)

    const record = (summary, why) => {
      const row = { at: now(), tool, summary: String(summary || '').slice(0, 400) }
      t.denials.push(row)
      if (t.denials.length > 100) t.denials.splice(0, t.denials.length - 100)
      event(t, 'deny', `${tool} · ${row.summary} · ${why}`)
      save(d || { version: 1, task: t })
      try { writeStateMd(t) } catch { /* ignore */ }
    }

    if (WRITE_TOOLS.has(tool)) {
      const p = String(args.path || args.file_path || args.filePath || args.target || '')
      const abs = p ? resolve(t.dir, p) : ''
      if (abs && underSpecs(t, abs)) return undefined
      const g = t.gates[t.stage]
      const open = t.stage === 'EXECUTE' && g && g.status === 'confirmed'
      if (open) return undefined
      record(p || '(未给路径)', `阶段 ${t.stage}`)
      return `规格闸门拒绝：当前阶段 ${t.stage} 未确认（${g ? g.status : 'pending'}），不允许改 ${abs || '文件'}。请先在「规格闸门」标签页确认对应阶段。`
    }

    if (SHELL_TOOLS.has(tool)) {
      const cmd = String(args.command || args.cmd || args.script || '')
      if (!cmd) return undefined
      if (!WRITE_CMD.test(cmd)) return undefined
      const g = t.gates[t.stage]
      const open = t.stage === 'EXECUTE' && g && g.status === 'confirmed'
      if (open) return undefined
      record(cmd.slice(0, 200), '命令疑似写文件')
      return `规格闸门拒绝：命令看起来会写文件（${cmd.slice(0, 120)}），而当前阶段 ${t.stage} 未确认。请先在标签页确认。`
    }

    return undefined
  }))

  /* ---------------- 3. 按钮通道（HTTP） ---------------- */

  const sameOrigin = (req) => {
    // 实测：桌面 webview 的 POST 不带 sec-fetch-site / origin / referer（debug.jsonl 里全是 null），
    // 所以只能靠 UA 认「是不是这个应用自己的页面发的」。
    // 这挡的是顺手用 curl / PowerShell 伪造确认，挡不住铁了心改 UA 的人 —— 已知缺口，写进 README。
    const ua = String(req.headers['user-agent'] || '')
    return ua.includes('dsh-desktop')
  }

  const sendJson = (res, code, obj) => {
    try {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch { try { res.end() } catch { /* ignore */ } }
  }

  const readBody = (req) => new Promise((resolveBody) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolveBody(JSON.parse(buf || '{}')) } catch { resolveBody({}) }
    })
    req.on('error', () => resolveBody({}))
  })

  disposers.push(ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/spec-gate',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const p = url.pathname.replace(/^\/api\/spec-gate/, '') || '/'
        const d = db()

        if (req.method === 'GET' && p === '/state') {
          const sid = String(url.searchParams.get('session') || '')
          const t = d.task
          if (!t) return sendJson(res, 200, { ok: true, active: false, task: null })
          const bound = t.sessionId ? t.sessionId === sid : true
          return sendJson(res, 200, { ok: true, ...stateSnapshot(t), bound })
        }

        if (req.method === 'POST') {
          appendJsonl(DEBUG_FILE, {
            at: now(),
            where: 'post',
            path: p,
            site: req.headers['sec-fetch-site'] ?? null,
            origin: req.headers.origin ?? null,
            referer: req.headers.referer ?? null,
            ua: String(req.headers['user-agent'] || '').slice(0, 120),
          })
        }

        if (req.method === 'POST' && (p === '/confirm' || p === '/cancel' || p === '/reject')) {
          if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '只接受「规格闸门」标签页里的点击（这次请求不是应用页面发的）。' })
          const body = await readBody(req)
          const t = d.task
          if (!t || t.status !== 'active') return sendJson(res, 200, { ok: false, error: '没有活跃任务' })
          if (t.sessionId && body.session && String(body.session) !== t.sessionId) {
            return sendJson(res, 403, { ok: false, error: '这个任务不属于当前会话' })
          }

          if (p === '/cancel') {
            t.status = 'cancelled'
            t.awaiting = null
            event(t, 'cancel', '用户在标签页取消')
            save(d)
            writeStateMd(t)
            return sendJson(res, 200, { ok: true, status: 'cancelled' })
          }

          const stage = String(body.stage || t.stage)
          if (p === '/reject') {
            t.gates[stage] = { status: 'rejected', at: now(), quote: String(body.quote || '(驳回，未留原话)'), scope: null }
            t.awaiting = null
            event(t, 'reject', `${stage} 被用户驳回`)
            save(d)
            writeStateMd(t)
            return sendJson(res, 200, { ok: true, stage, status: 'rejected' })
          }

          if (!t.awaiting || t.awaiting.stage !== stage) {
            return sendJson(res, 200, { ok: false, error: `没有待确认的 ${stage} 卡片` })
          }
          t.gates[stage] = {
            status: 'confirmed',
            at: now(),
            quote: String(body.quote || '（按钮确认）'),
            scope: stage === 'EXECUTE' ? '按 PLAN 的步骤执行' : null,
          }
          t.awaiting = null
          const idx = STAGES.indexOf(stage)
          if (idx >= 0 && idx + 1 < STAGES.length) t.stage = STAGES[idx + 1]
          event(t, 'confirm', `${stage} 由用户按钮确认 → 进入 ${t.stage}`)
          save(d)
          writeStateMd(t)
          return sendJson(res, 200, { ok: true, stage, next: t.stage })
        }

        return sendJson(res, 404, { ok: false, error: 'unknown route' })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e && e.message) })
      }
    },
  }), 'spec-gate routes'))

  bootLog(`apply() 完成：5 个工具已注册，路由 /api/spec-gate 已挂`)

  return () => { for (const off of disposers) { try { off() } catch { /* ignore */ } } }
}
