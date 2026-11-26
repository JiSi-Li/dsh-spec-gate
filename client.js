/**
 * dsh-spec-gate —— 浏览器半端（顶栏 tab「规格闸门」）
 * ---------------------------------------------------------------------------
 * 自注册脚本，非 ESM（见 dsh-doc/references/ui-plugin.md）。
 * tab 按会话出现：`conversation.view` 是 list 槽、没有隐藏开关，
 * 只能靠 `conversation.input.left` 的隐藏探针问宿主「这个会话有活跃任务吗」，
 * 有就注册、没有就撤销（抄 dsh-bili-scroll/client.js:1084-1158 的做法）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-spec-gate',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/spec-gate'
    const STAGES = ['SPEC', 'PLAN', 'EXECUTE', 'VERIFY', 'ACCEPT']
    const LABEL = { SPEC: '规格', PLAN: '计划', EXECUTE: '执行', VERIFY: '自检', ACCEPT: '验收' }

    const asJson = async (res) => {
      if (res.ok) return res.json()
      let detail = ''
      try {
        const j = await res.json()
        if (j && j.error) detail = String(j.error)
      } catch { /* 非 JSON 响应就算了 */ }
      throw new Error('HTTP ' + res.status + (detail ? ' · ' + detail : ''))
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    let SID = ''            // 探针拿到的会话 id
    let VIEW_ON = false

    const CSS = `
[data-sg]{display:flex;flex-direction:column;gap:14px;padding:16px 18px 24px;max-width:760px;font-size:13px;}
[data-sg-stage]{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
[data-sg-chip]{padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border,#2a2a2a);color:var(--dsw-alias-label-secondary,#8a8f98);}
[data-sg-chip][data-on="confirmed"]{background:#17361f;border-color:#2f6b40;color:#7ee2a8;}
[data-sg-chip][data-on="pending"]{border-color:#4a4a1f;color:#e0d27a;}
[data-sg-chip][data-on="rejected"]{background:#3a1616;border-color:#7a2b2b;color:#f19a9a;}
[data-sg-card]{border:1px solid var(--dsw-alias-border,#2a2a2a);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}
[data-sg-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-sg-btn]{border:1px solid var(--dsw-alias-border,#2a2a2a);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;}
[data-sg-btn][data-primary]{background:#2f6b40;border-color:#39824f;color:#eafff0;}
[data-sg-btn][data-danger]{border-color:#7a2b2b;color:#f19a9a;background:transparent;}
[data-sg-btn][disabled]{opacity:.5;cursor:default;}
[data-sg-mut]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-sg-deny]{font-size:11px;line-height:17px;border-left:2px solid #7a2b2b;padding-left:8px;margin-bottom:6px;color:var(--dsw-alias-label-secondary,#8a8f98);}
[data-sg-row]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
`

    function StageBar({ gates, stage }) {
      return h('div', { 'data-sg-stage': '' }, STAGES.map((s) => {
        const g = (gates && gates[s]) || { status: 'pending' }
        const on = s === stage
        return h('span', {
          key: s,
          'data-sg-chip': '',
          'data-on': g.status,
          style: on ? { boxShadow: '0 0 0 1px #39824f inset' } : undefined,
        }, `${LABEL[s]} ${g.status === 'confirmed' ? '✓' : g.status === 'rejected' ? '✕' : '·'}`)
      }))
    }

    function Tab() {
      const [state, setState] = React.useState({ loading: true, active: false, task: null })
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')

      const refresh = React.useCallback(() => {
        const q = SID ? '?session=' + encodeURIComponent(SID) : ''
        jget('/state' + q)
          .then((r) => setState({ loading: false, ...r }))
          .catch((e) => setState({ loading: false, active: false, task: null, error: String(e && e.message) }))
      }, [])

      React.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 2500)
        return () => clearInterval(t)
      }, [refresh])

      const act = async (path, body) => {
        setBusy(true); setErr('')
        try {
          const r = await jpost(path, { session: SID, ...body })
          if (r && r.ok === false) setErr(r.error || '操作失败')
        } catch (e) {
          setErr(String(e && e.message))
        } finally {
          setBusy(false)
          refresh()
        }
      }

      const t = state.task
      if (state.loading) return h('div', { 'data-sg': '' }, h('div', { 'data-sg-mut': '' }, '读取中…'))
      if (!t) return h('div', { 'data-sg': '' }, h('div', { 'data-sg-mut': '' }, '当前会话没有活跃的规格任务。'))
      if (!state.active) return h('div', { 'data-sg': '' },
        h('div', { 'data-sg-h': '' }, '任务已结束'),
        h('div', { 'data-sg-mut': '' }, `${t.title}（${t.status}）`))

      const awaiting = t.awaiting
      return h('div', { 'data-sg': '' },
        h('div', { 'data-sg-row': '' },
          h('div', { 'data-sg-h': '' }, '规格闸门'),
          h('span', { 'data-sg-mut': '' }, `${t.title}　·　${t.slug}　·　当前 ${LABEL[t.stage] || t.stage}`)),
        h(StageBar, { gates: t.gates, stage: t.stage }),

        awaiting
          ? h('div', { 'data-sg-card': '' },
            h('div', { 'data-sg-h': '' }, `等你确认：${LABEL[awaiting.stage] || awaiting.stage}`),
            h('div', {}, awaiting.summary || '（没有摘要）'),
            h('div', { 'data-sg-row': '' },
              h('button', {
                'data-sg-btn': '', 'data-primary': '',
                disabled: busy,
                onClick: () => act('/confirm', { stage: awaiting.stage, quote: '（用户在标签页点按钮确认）' }),
              }, `确认「${LABEL[awaiting.stage] || awaiting.stage}」`),
              h('button', {
                'data-sg-btn': '',
                disabled: busy,
                onClick: () => act('/reject', { stage: awaiting.stage }),
              }, '驳回'),
              h('button', {
                'data-sg-btn': '', 'data-danger': '',
                disabled: busy,
                onClick: () => act('/cancel', {}),
              }, '取消任务')),
            h('div', { 'data-sg-mut': '' }, '确认只能在这里点；对话里说「可以」不算，闸门照旧。'))
          : h('div', { 'data-sg-card': '' },
            h('div', { 'data-sg-h': '' }, '没有待确认项'),
            h('div', { 'data-sg-mut': '' }, `现在在 ${LABEL[t.stage] || t.stage} 阶段；等我提交卡片，或点下面取消。`),
            h('div', { 'data-sg-row': '' },
              h('button', {
                'data-sg-btn': '', 'data-danger': '',
                disabled: busy,
                onClick: () => act('/cancel', {}),
              }, '取消任务'))),

        err ? h('div', { 'data-sg-mut': '', style: { color: '#f19a9a' } }, err) : null,

        (t.denials && t.denials.length)
          ? h('div', { 'data-sg-card': '' },
            h('div', { 'data-sg-h': '' }, `被拦下的操作（最近 ${t.denials.length} 条）`),
            t.denials.slice().reverse().map((d, i) =>
              h('div', { key: i, 'data-sg-deny': '' }, `${new Date(d.at).toLocaleTimeString()} · ${d.tool} · ${d.summary}`)))
          : null,

        (t.history && t.history.length)
          ? h('div', { 'data-sg-card': '' },
            h('div', { 'data-sg-h': '' }, '事件记录'),
            h('div', { 'data-sg-mut': '' }, t.history.slice().reverse().map((x, i) =>
              h('div', { key: i }, `${new Date(x.at).toLocaleTimeString()} · ${x.kind} · ${x.detail}`))))
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        ctx.effect(() => {
          const el = document.createElement('style')
          el.setAttribute('data-sg-css', '')
          el.textContent = CSS
          document.head.appendChild(el)
          return () => { try { el.remove() } catch { /* ignore */ } }
        }, 'spec-gate styles')

        let viewOff = null
        let ready = false
        let inScope = false

        const dropView = () => {
          if (!viewOff) return
          try { viewOff() } catch { /* 已撤销 */ }
          viewOff = null
          VIEW_ON = false
        }
        const ensureView = () => {
          if (viewOff || !ready) return
          try {
            viewOff = slots.register({
              name: 'conversation.view',
              id: 'spec-gate',
              order: 30,
              label: '规格闸门',
              scope: 'session',
            }, () => h(Tab))
            VIEW_ON = true
          } catch (e) { viewOff = null }
        }

        slots.inject('conversation.view', () => {
          ready = true
          if (inScope) ensureView()
          return () => { ready = false; dropView() }
        })

        const Probe = ({ sessionId }) => {
          React.useEffect(() => {
            const sid = String(sessionId || '')
            SID = sid
            let alive = true
            const check = () => {
              const q = sid ? '?session=' + encodeURIComponent(sid) : ''
              jget('/state' + q).then((r) => {
                if (!alive) return
                const on = Boolean(r && r.active && r.task && r.task.status === 'active' && (r.bound !== false || !sid))
                inScope = on
                if (on) ensureView(); else dropView()
              }).catch(() => { /* 宿主没装好就什么都不显示 */ })
            }
            check()
            const timer = setInterval(check, 4000)
            return () => { alive = false; clearInterval(timer); dropView() }
          }, [sessionId])
          return h('span', { 'data-sg-probe': '', style: { display: 'none' } })
        }

        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'spec-gate-probe',
          order: 6,
        }, (props) => h(Probe, props || {})))
      },
    }
  },
})
