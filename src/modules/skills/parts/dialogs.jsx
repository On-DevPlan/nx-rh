// Skill 页的两个弹窗：新建/编辑器（订阅源侧写）与「收进订阅源」选源弹窗。
import { useEffect, useState } from 'react';
import { api } from '../../../web/frontend/api/client.js';
import { useStore } from '../../../web/frontend/store.jsx';
import { useToast, useGuard, useDialog, Modal } from '../../../web/frontend/components/ui.jsx';
import { sourceLabel } from '../shared.js';

// skill 编辑器（新建 / 编辑，弹窗）
export function SkillEditor({ mode, skill = {}, close, reload }) {
  const { toast } = useToast();
  const isEdit = mode === 'edit';
  const [name, setName] = useState(skill.name || '');
  const [description, setDescription] = useState(skill.description || '');
  const [content, setContent] = useState(skill.content || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setErr('');
    if (!isEdit && !name.trim()) { setErr('需要一个 skill 名（小写连字符）'); return; }
    setBusy(true);
    try {
      if (isEdit) {
        await api('/api/skills/' + encodeURIComponent(skill.name), { method: 'PATCH', body: { content } });
      } else {
        await api('/api/skills', { method: 'POST', body: { name: name.trim(), description, content } });
      }
      toast(isEdit ? '已保存' : '已创建');
      close();
      await reload();
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {err ? <div className="tag bad" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{err}</div> : null}
      {!isEdit ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input style={{ flex: 1 }} placeholder="skill 名（小写连字符，如 my-skill）" value={name} spellCheck="false" onChange={(e) => setName(e.target.value)} />
          <input style={{ flex: 2 }} placeholder="一句话描述（写入 frontmatter）" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      ) : null}
      <textarea
        style={{
          width: '100%', minHeight: 320, padding: 8,
          fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5,
          border: '1px solid var(--soft-2)', borderRadius: 4, background: 'var(--paper)', color: 'var(--ink)',
        }}
        spellCheck="false"
        placeholder={
          isEdit ? ''
            : '正文（留空则自动生成 frontmatter 与标题）。\n也可以直接给完整 SKILL.md（以 --- 开头，name 须与上面一致）。'
        }
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={close}>取消</button>
        <button className="btn" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </>
  );
}

// 收进订阅源：选源弹窗（submit 的目标源可挑，缺省主源）
export function SubmitIntoDialog({ names, onClose, onDone }) {
  const { boot, refreshBoot } = useStore();
  const toast = useToast();
  const guard = useGuard();
  const { dialog, node: dlgNode } = useDialog();
  const sources = boot?.sources || [];
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);

  // 缺省选中主源；sources 晚一拍到达时补上
  useEffect(() => {
    if (!into && sources.length) setInto((sources.find((s) => s.current) || sources[0]).path);
  }, [into, sources]);

  const srcPaths = sources.map((s) => s.path);
  const srcLabel = (p) => sourceLabel(p, srcPaths);

  const ok = () => guard(async () => {
    if (!into) { toast('请选择订阅源'); return; }
    setBusy(true);
    try {
      let r = await api('/api/skills/submit', { method: 'POST', body: { name: names, to: 'all', platform: 'all', into } });
      if (r.status === 'conflict') {
        const go = await dialog({ message: `订阅源里已有同名且内容不同（${r.conflicts.length} 个 skill）。用这份覆盖？`, danger: true });
        if (!go) return;
        r = await api('/api/skills/submit', { method: 'POST', body: { name: names, to: 'all', platform: 'all', into, force: true } });
      }
      toast(`已收进 ${srcLabel(into)}（${r.submitted} 个，跳过 ${r.skipped}）`);
      await refreshBoot();
      onDone();
    } finally {
      setBusy(false);
    }
  });

  return (
    <Modal title={`收进订阅源（${names.length} 个 skill）`} onClose={onClose}>
      <div className="vlegend">收进后删除平台目录里的实文件，并改回指向订阅源的软链接。</div>
      <div className="list">
        {sources.length ? sources.map((s) => (
          <label key={s.path} className="row src-row">
            <input type="radio" name="submit-into" checked={into === s.path} onChange={() => setInto(s.path)} />
            <span className="name">{srcLabel(s.path)}{s.current ? '（主源）' : ''}</span>
            <span className="desc mono" title={s.path}>{s.path}</span>
            {!s.exists ? <span className="tag bad">不存在</span> : null}
          </label>
        )) : <div className="row muted">（还没有订阅源，先在总览页订阅一个目录）</div>}
      </div>
      <div className="dlg-acts">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" disabled={busy || !sources.length} onClick={ok}>{busy ? '提交中…' : '收进'}</button>
      </div>
      {dlgNode}
    </Modal>
  );
}
