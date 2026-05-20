import { useState } from 'react'
import { CP_LABEL, CP_SYMBOL } from '../utils'

export default function CpEditor({ cp, takenTypes = [], onSave, onCancel }) {
  const [form, setForm] = useState({ ...cp })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const changeType = (t) => {
    setForm(f => ({
      ...f,
      type: t,
      usage: t === 'cp' ? (f.usage || 'both') : null,
      score: t === 'cp' ? f.score : null,
    }))
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{CP_SYMBOL[form.type]} {form.type === 'cp' ? `CP${form.number}` : CP_LABEL[form.type]} の編集</h3>

        <div className="form-row">
          <span className="form-label">種別</span>
          <select className="ctrl-select" value={form.type} onChange={e => changeType(e.target.value)}>
            <option value="start" disabled={takenTypes.includes('start')}>
              △ スタート{takenTypes.includes('start') ? '（配置済み）' : ''}
            </option>
            <option value="cp">○ CP</option>
            <option value="finish" disabled={takenTypes.includes('finish')}>
              ◎ フィニッシュ{takenTypes.includes('finish') ? '（配置済み）' : ''}
            </option>
          </select>
        </div>

        {form.type === 'cp' && (
          <div className="form-row">
            <span className="form-label">用途</span>
            <select className="ctrl-select" value={form.usage || 'both'}
              onChange={e => set('usage', e.target.value)}>
              <option value="straight">ストレート用</option>
              <option value="score">スコア用</option>
              <option value="both">両用</option>
            </select>
          </div>
        )}

        {form.type === 'cp' && (form.usage === 'score' || form.usage === 'both') && (
          <div className="form-row">
            <span className="form-label">スコアポイント</span>
            <input className="ctrl-input" type="number" min="1" value={form.score || ''}
              onChange={e => set('score', e.target.value ? parseInt(e.target.value) : null)} />
          </div>
        )}

        <div className="form-row">
          <span className="form-label">緯度</span>
          <input className="ctrl-input" type="number" step="0.000001" value={form.lat}
            onChange={e => set('lat', parseFloat(e.target.value))} />
        </div>
        <div className="form-row">
          <span className="form-label">経度</span>
          <input className="ctrl-input" type="number" step="0.000001" value={form.lng}
            onChange={e => set('lng', parseFloat(e.target.value))} />
        </div>
        <div className="form-row">
          <span className="form-label">メモ</span>
          <input className="ctrl-input" type="text" value={form.memo || ''}
            onChange={e => set('memo', e.target.value)} />
        </div>

        <div className="modal-btns">
          <button className="btn btn-secondary" onClick={onCancel}>キャンセル</button>
          <button className="btn btn-primary" onClick={() => onSave(form)}>保存</button>
        </div>
      </div>
    </div>
  )
}
