import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import { get, set } from 'idb-keyval';
import JSZip from 'jszip';
import { SAMPLE } from './sample';
import './style.css';

type Files = Record<string, string>;
type Diag = { file: string; line: number; col: number; severity: 'error' | 'warning'; message: string };
type View = 'explorer' | 'search' | 'settings';
type Msg = { files: Files; entry: string; stdin: string; game: boolean };
const PYO = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const OKPATH = /^[A-Za-z0-9_./-]+$/;
const lang = (p: string) => p.endsWith('.py') ? 'python' : p.endsWith('.json') ? 'json' : p.endsWith('.md') ? 'markdown' : 'plaintext';
const ls = (k: string, d: string) => localStorage.getItem(k) ?? d;

// Runs a project inside Pyodide. Stringified and injected into a Worker (console) or iframe (pygame).
async function runProject(py: any, m: Msg, post: (t: string, d: string) => void, canvas?: any) {
  const lines = m.stdin ? m.stdin.split('\n') : []; let i = 0;
  py.setStdin({ stdin: () => (m.game ? prompt('Program input') : (i < lines.length ? lines[i++] : null)) });
  py.setStdout({ batched: (s: string) => post('out', s) });
  py.setStderr({ batched: (s: string) => post('out', s) });
  py.runPython("import shutil, os\nshutil.rmtree('/proj', ignore_errors=True)\nos.makedirs('/proj')");
  for (const p of Object.keys(m.files)) {
    if (p.endsWith('.gitkeep')) continue;
    const d = '/proj/' + p; py.FS.mkdirTree(d.slice(0, d.lastIndexOf('/'))); py.FS.writeFile(d, m.files[p]);
  }
  const all = Object.keys(m.files).filter(p => p.endsWith('.py')).map(p => m.files[p]).join('\n');
  await py.loadPackagesFromImports(all);
  const reqs = (m.files['requirements.txt'] || '').split('\n').map(s => s.trim()).filter(s => s && s[0] !== '#');
  if (reqs.length) { await py.loadPackage('micropip'); const mp = py.pyimport('micropip'); for (const r of reqs) { post('out', '[pip] installing ' + r); await mp.install(r); } }
  if (canvas && py.canvas && py.canvas.setCanvas2D) py.canvas.setCanvas2D(canvas);
  py.globals.set('ENTRY', m.entry);
  await py.runPythonAsync([
    'import sys, os, asyncio',
    'from pyodide.code import eval_code_async',
    "os.chdir('/proj')",
    "if '/proj' not in sys.path: sys.path.insert(0, '/proj')",
    "for k in [k for k, v in list(sys.modules.items()) if str(getattr(v, '__file__', '') or '').startswith('/proj')]: del sys.modules[k]",
    'asyncio.run = lambda coro, **kw: asyncio.ensure_future(coro)',
    'src = open(ENTRY).read()',
    "await eval_code_async(src, {'__name__': '__main__', '__file__': '/proj/' + ENTRY}, filename=ENTRY)",
    'cur = asyncio.current_task()',
    'pend = [t for t in asyncio.all_tasks() if t is not cur]',
    'if pend: await asyncio.gather(*pend)',
  ].join('\n'));
}
const workerSrc = "importScripts('" + PYO + "pyodide.js');\n" + runProject.toString() +
  "\nlet py;\nonmessage = async (ev) => { const post = (t, d) => postMessage({ t, d }); try { if (!py) { post('out', '[loading Python runtime, first run takes a while...]'); py = await loadPyodide(); } await runProject(py, ev.data, post); post('done', ''); } catch (e) { post('err', String((e && e.message) || e)); } };";
const gameDoc = (m: Msg) => '<!doctype html><body style="margin:0;background:#000"><canvas id="canvas" tabindex="1" style="width:100%;touch-action:none;outline:none" oncontextmenu="return false"></canvas>' +
  '<script src="' + PYO + 'pyodide.js"></scr' + 'ipt><script>' + runProject.toString() +
  ';(async()=>{const post=(t,d)=>parent.postMessage({t,d},"*");const m=' + JSON.stringify(m).replace(/</g, '\\u003c') +
  ';try{post("out","[loading Python + pygame, first run takes a while...]");const py=await loadPyodide();const c=document.getElementById("canvas");c.focus();await runProject(py,m,post,c);post("done","");}catch(e){post("err",String((e&&e.message)||e));}})();</scr' + 'ipt></body>';

function parseTb(t: string): Diag[] {
  const re = /File "([^"]+)", line (\d+)/g; let m; let last: { file: string; line: number } | null = null;
  while ((m = re.exec(t))) { const f = m[1].replace(/^\/proj\//, ''); if (!f.startsWith('/') && !f.startsWith('<')) last = { file: f, line: +m[2] }; }
  if (!last) return [];
  return [{ ...last, col: 1, severity: 'error', message: t.trim().split('\n').pop() || 'error' }];
}

const SNIPS: [string, string][] = [
  ['def', 'def ${1:name}(${2}):\n\t${3:pass}'], ['class', 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${3:pass}'],
  ['for', 'for ${1:i} in range(${2:10}):\n\t${3:pass}'], ['fore', 'for ${1:x} in ${2:items}:\n\t${3:pass}'], ['while', 'while ${1:cond}:\n\t${2:pass}'],
  ['if', 'if ${1:cond}:\n\t${2:pass}'], ['ifelse', 'if ${1:cond}:\n\t${2:pass}\nelse:\n\t${3:pass}'], ['ifmain', 'if __name__ == "__main__":\n\t${1:main()}'],
  ['try', 'try:\n\t${1:pass}\nexcept ${2:Exception} as e:\n\t${3:print(e)}'], ['with', 'with open(${1:"file.txt"}) as f:\n\t${2:pass}'],
  ['lc', '[${1:x} for ${1:x} in ${2:items}]'], ['pygame', 'import asyncio\nimport pygame\n\npygame.init()\nscreen = pygame.display.set_mode((640, 360))\nclock = pygame.time.Clock()\n\n\nasync def main():\n\twhile True:\n\t\tfor e in pygame.event.get():\n\t\t\tif e.type == pygame.QUIT:\n\t\t\t\treturn\n\t\tscreen.fill((30, 30, 40))\n\t\t${1}\n\t\tpygame.display.flip()\n\t\tclock.tick(60)\n\t\tawait asyncio.sleep(0)\n\n\nasyncio.run(main())'],
];
const WORDS = ('print input len range int float str bool list dict set tuple enumerate zip map filter sorted sum min max abs round open isinstance super self None True False import from return yield lambda async await ' +
  'pygame.init pygame.display.set_mode pygame.display.flip pygame.event.get pygame.draw.circle pygame.draw.rect pygame.draw.line pygame.Rect pygame.time.Clock pygame.key.get_pressed pygame.mouse.get_pos pygame.font.Font pygame.QUIT pygame.KEYDOWN pygame.MOUSEBUTTONDOWN asyncio.sleep').split(' ');
let registered = false;
function registerPy(m: any) {
  if (registered) return; registered = true;
  m.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    provideCompletionItems: (model: any, pos: any) => {
      const w = model.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      return { suggestions: [...SNIPS.map(([l, t]) => ({ label: l, kind: 27, insertText: t, insertTextRules: 4, range })), ...WORDS.map(l => ({ label: l, kind: 5, insertText: l, range }))] };
    },
  });
}

function App() {
  const [files, setFiles] = useState<Files>(SAMPLE);
  const [open, setOpen] = useState<string[]>(['main.py']);
  const [active, setActive] = useState('main.py');
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [log, setLog] = useState('');
  const [diags, setDiags] = useState<Diag[]>([]);
  const [tab, setTab] = useState<'console' | 'errors' | 'input'>('console');
  const [stdin, setStdin] = useState('');
  const [doc, setDoc] = useState('');
  const [gameKey, setGameKey] = useState(0);
  const [full, setFull] = useState(false);
  const [showPv, setShowPv] = useState(true);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<View>('explorer');
  const [sel, setSel] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [pal, setPal] = useState<{ text: string; idx: number } | null>(null);
  const [pos, setPos] = useState({ l: 1, c: 1 });
  const [fs, setFs] = useState(Number(ls('fs', '14')));
  const [minimap, setMinimap] = useState(ls('minimap', '1') === '1');
  const [wrap, setWrap] = useState(ls('wrap', '1') === '1');
  const ed = useRef<any>(null); const mon = useRef<any>(null); const loaded = useRef(false); const worker = useRef<Worker | null>(null);
  const say = (s: string) => setLog(l => l + s + '\n');
  const persist = (k: string, v: string) => localStorage.setItem(k, v);

  const markers = (d: Diag[]) => { const m = mon.current; if (!m) return; m.editor.getModels().forEach((mod: any) => { const f = mod.uri.path.replace(/^\//, ''); m.editor.setModelMarkers(mod, 'py', d.filter(x => f.endsWith(x.file)).map(x => ({ startLineNumber: x.line, startColumn: 1, endLineNumber: x.line, endColumn: 300, message: x.message, severity: 8 }))); }); };
  const handle = (d: { t: string; d: string }) => {
    if (!d || !d.t) return;
    if (d.t === 'out') say(d.d);
    else if (d.t === 'done') { setRunning(false); setStatus('Finished'); say('[done]'); }
    else if (d.t === 'err') { setRunning(false); setStatus('Error'); say(d.d); const ds = parseTb(d.d); setDiags(ds); markers(ds); if (ds.length) setTab('errors'); }
  };

  useEffect(() => { get('pyproject').then(v => { if (v && Object.keys(v).length) setFiles(v); loaded.current = true; }); }, []);
  useEffect(() => { if (!loaded.current) return; const t = setTimeout(() => { set('pyproject', files).then(() => setStatus('Saved locally')); setDirty(new Set()); }, 800); return () => clearTimeout(t); }, [files]);
  useEffect(() => { const h = (e: MessageEvent) => handle(e.data); window.addEventListener('message', h); return () => window.removeEventListener('message', h); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey; if (!mod) return; const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'enter') { e.preventDefault(); run(); }
      else if (k === 'p') { e.preventDefault(); setPal({ text: e.shiftKey ? '>' : '', idx: 0 }); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); setView('search'); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const edit = (v?: string) => { setFiles(f => ({ ...f, [active]: v ?? '' })); setDirty(d => new Set(d).add(active)); };
  const openFile = (p: string) => { setOpen(o => o.includes(p) ? o : [...o, p]); setActive(p); };
  const revealAt = (p: string, line: number, col: number) => { openFile(p); setTimeout(() => { ed.current?.revealLineInCenter(line); ed.current?.setPosition({ lineNumber: line, column: col }); ed.current?.focus(); }, 150); };
  const closeTab = (p: string) => { const o = open.filter(x => x !== p); setOpen(o); if (active === p) setActive(o[o.length - 1] || ''); };
  const base = () => (sel ? sel + '/' : '');
  const newFile = () => { const p = prompt('New file path', base() + 'new.py'); if (!p) return; if (!OKPATH.test(p) || p.includes('..') || p.startsWith('/')) return alert('Invalid path (letters, digits, _ . / - only)'); if (files[p] !== undefined) return alert('Exists'); setFiles({ ...files, [p]: '' }); openFile(p); };
  const newFolder = () => { const p = (prompt('New folder path', base() + 'newfolder') || '').replace(/\/+$/, ''); if (!p) return; if (!OKPATH.test(p) || p.includes('..') || p.startsWith('/')) return alert('Invalid path'); const k = p + '/.gitkeep'; if (files[k] !== undefined) return alert('Exists'); setFiles({ ...files, [k]: '' }); setCollapsed(c => { const n = new Set(c); n.delete(p); return n; }); setSel(p); };
  const rename = (p: string, dir = false) => {
    const n = (prompt('Rename / move to', p) || '').replace(/\/+$/, ''); if (!n || n === p || !OKPATH.test(n) || n.includes('..') || n.startsWith('/')) return;
    const nf: Files = {}; const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) { const nk = dir ? (k.startsWith(p + '/') ? n + k.slice(p.length) : k) : (k === p ? n : k); if (nk !== k) map[k] = nk; nf[nk] = v; }
    if (!Object.keys(map).length) return;
    if (Object.keys(nf).length !== Object.keys(files).length) return alert('Name already exists');
    setFiles(nf); setOpen(open.map(x => map[x] || x)); if (map[active]) setActive(map[active]); if (dir) setSel(n);
  };
  const del = (p: string, dir = false) => {
    if (!confirm('Delete ' + p + (dir ? ' and everything in it?' : '?'))) return;
    const gone = (k: string) => dir ? k.startsWith(p + '/') : k === p;
    const nf: Files = {}; for (const [k, v] of Object.entries(files)) if (!gone(k)) nf[k] = v;
    setFiles(nf); const o = open.filter(x => !gone(x)); setOpen(o); if (gone(active)) setActive(o[o.length - 1] || ''); if (dir) setSel('');
  };
  const rows = (() => {
    const dirs = new Set<string>(); Object.keys(files).forEach(k => { const a = k.split('/'); for (let i = 1; i < a.length; i++) dirs.add(a.slice(0, i).join('/')); });
    const ents = [...[...dirs].map(p => ({ p, dir: true })), ...Object.keys(files).filter(k => !k.endsWith('.gitkeep')).map(p => ({ p, dir: false }))];
    ents.sort((a, b) => { const A = a.p.split('/'), B = b.p.split('/'); for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) { const ad = i < A.length - 1 || a.dir, bd = i < B.length - 1 || b.dir; if (ad !== bd) return ad ? -1 : 1; return A[i] < B[i] ? -1 : 1; } return A.length - B.length; });
    return ents.filter(e => { const a = e.p.split('/'); for (let i = 1; i < a.length; i++) if (collapsed.has(a.slice(0, i).join('/'))) return false; return true; });
  })();
  const results = query.length > 1 ? Object.entries(files).flatMap(([p, c]) => p.endsWith('.gitkeep') ? [] : c.split('\n').flatMap((l, i) => { const k = l.toLowerCase().indexOf(query.toLowerCase()); return k >= 0 ? [{ p, line: i + 1, col: k + 1, text: l.trim().slice(0, 80) }] : []; })).slice(0, 200) : [];

  const save = async () => { await set('pyproject', files); setStatus('Saved locally'); };
  const exportZip = async () => { const name = (prompt('ZIP file name', 'MyPython') || '').replace(/[^A-Za-z0-9_-]/g, ''); if (!name) return; const z = new JSZip(); Object.entries(files).forEach(([p, c]) => z.file(p, c)); const u = URL.createObjectURL(await z.generateAsync({ type: 'blob' })); const a = document.createElement('a'); a.href = u; a.download = name + '.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); };
  const importZip = async (f?: File) => { if (!f) return; const z = await JSZip.loadAsync(f); const n: Files = {}; for (const [p, e] of Object.entries(z.files)) if (!e.dir && OKPATH.test(p) && !p.includes('..') && (/\.(py|txt|json|md|cfg|toml|csv|ini)$/.test(p) || p.endsWith('.gitkeep'))) n[p] = await e.async('string'); if (!Object.keys(n).length) return alert('No supported files in ZIP'); setFiles(n); setOpen([]); setActive(''); };

  const run = () => {
    if (running) return;
    const entry = active.endsWith('.py') ? active : (files['main.py'] !== undefined ? 'main.py' : Object.keys(files).find(f => f.endsWith('.py')));
    if (!entry) return alert('No .py file to run');
    const game = Object.entries(files).some(([p, c]) => p.endsWith('.py') && /^\s*(import|from)\s+pygame/m.test(c));
    setLog(''); setDiags([]); markers([]); setTab('console'); setRunning(true); setStatus('Running ' + entry + (game ? ' (pygame)' : ''));
    const msg: Msg = { files, entry, stdin, game };
    if (game) { setShowPv(true); setDoc(gameDoc(msg)); setGameKey(k => k + 1); }
    else {
      if (!worker.current) { const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }))); w.onmessage = ev => handle(ev.data); w.onerror = ev => { say('Worker error: ' + ev.message); setRunning(false); }; worker.current = w; }
      worker.current.postMessage(msg);
    }
  };
  const stop = () => { if (worker.current) { worker.current.terminate(); worker.current = null; } setDoc(''); setRunning(false); setStatus('Stopped'); say('[stopped]'); };

  const cmds: [string, () => void][] = [
    ['Run Current File', run], ['Stop', stop], ['Save', save], ['New File', newFile], ['New Folder', newFolder], ['Export ZIP', exportZip],
    ['Toggle Preview', () => setShowPv(v => !v)], ['Toggle Minimap', () => { setMinimap(!minimap); persist('minimap', minimap ? '0' : '1'); }],
    ['Toggle Word Wrap', () => { setWrap(!wrap); persist('wrap', wrap ? '0' : '1'); }], ['Search in Files', () => setView('search')], ['Open Settings', () => setView('settings')],
    ['Format Document', () => ed.current?.getAction('editor.action.formatDocument')?.run()], ['Find and Replace', () => ed.current?.getAction('editor.action.startFindReplace')?.run()],
  ];
  const palItems = pal ? (pal.text.startsWith('>')
    ? cmds.filter(([n]) => n.toLowerCase().includes(pal.text.slice(1).trim().toLowerCase())).map(([n, f]) => ({ n, f }))
    : Object.keys(files).filter(p => !p.endsWith('.gitkeep') && p.toLowerCase().includes(pal.text.toLowerCase())).slice(0, 30).map(p => ({ n: p, f: () => openFile(p) }))) : [];
  const runPal = (i: number) => { const it = palItems[i]; setPal(null); if (it) setTimeout(it.f, 0); };

  const Icon = ({ d }: { d: React.ReactNode }) => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
  const chk = { width: 'auto', margin: '0 8px 0 0', minHeight: 0 } as const;

  return <div className="app">
    <div className="top">
      <b style={{ marginRight: 6 }}>Python Game Studio</b>
      <button className="pri" onClick={run} disabled={running}>Run</button><button onClick={stop} disabled={!running}>Stop</button>
      <button onClick={save}>Save</button>
      <button onClick={() => ed.current?.trigger('k', 'undo')}>Undo</button><button onClick={() => ed.current?.trigger('k', 'redo')}>Redo</button>
      <button onClick={() => { setDoc(''); setGameKey(k => k + 1); }}>Clear Preview</button>
      <button className={showPv ? 'on' : ''} onClick={() => setShowPv(!showPv)}>Preview</button>
      <button onClick={() => setPal({ text: '', idx: 0 })}>Go to File</button>
      <button onClick={() => setPal({ text: '>', idx: 0 })}>Commands</button>
    </div>
    <div className="act">
      <button className={view === 'explorer' ? 'on' : ''} title="Explorer" onClick={() => setView('explorer')}><Icon d={<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>} /></button>
      <button className={view === 'search' ? 'on' : ''} title="Search" onClick={() => setView('search')}><Icon d={<><circle cx="10" cy="10" r="6" /><path d="M15 15l6 6" /></>} /></button>
      <button className={view === 'settings' ? 'on' : ''} title="Settings" onClick={() => setView('settings')}><Icon d={<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>} /></button>
    </div>
    <div className="side">
      {view === 'explorer' && <>
        <div className="sh">Explorer: MyPython</div>
        <div style={{ padding: '0 8px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button onClick={newFile}>+File</button><button onClick={newFolder}>+Folder</button><button onClick={exportZip}>ZIP Export</button>
          <label><button onClick={e => (e.currentTarget.nextSibling as HTMLInputElement).click()}>ZIP Import</button><input type="file" accept=".zip" hidden onChange={e => importZip(e.target.files?.[0])} /></label>
          <button onClick={() => { if (confirm('Reset to sample project?')) { setFiles(SAMPLE); setSel(''); setOpen(['main.py']); setActive('main.py'); } }}>Reset</button>
        </div>
        {rows.map(({ p, dir }) => { const nm = p.split('/').pop(); const dp = p.split('/').length - 1; return <div key={(dir ? 'd:' : 'f:') + p} className={'file' + (!dir && p === active ? ' act' : '') + (dir && p === sel ? ' sel' : '')} style={{ paddingLeft: 10 + dp * 14 }}>
          <span style={{ flex: 1 }} onClick={() => { if (dir) { setSel(p); setCollapsed(c => { const n = new Set(c); n.has(p) ? n.delete(p) : n.add(p); return n; }); } else openFile(p); }}>{dir ? (collapsed.has(p) ? '> ' : 'v ') : (dirty.has(p) ? '* ' : '  ')}{nm}</span>
          <small onClick={() => rename(p, dir)}>Ren</small><small onClick={() => del(p, dir)}>Del</small></div>; })}
      </>}
      {view === 'search' && <>
        <div className="sh">Search</div>
        <input value={query} placeholder="Search in files" onChange={e => setQuery(e.target.value)} />
        <div className="res" style={{ color: '#858585' }}>{query.length > 1 ? results.length + ' results' : 'Type 2+ characters'}</div>
        {results.map((r, i) => <div key={i} className="res" onClick={() => revealAt(r.p, r.line, r.col)}><b>{r.p}:{r.line}</b> {r.text}</div>)}
      </>}
      {view === 'settings' && <>
        <div className="sh">Settings</div>
        <div className="res">Font size: {fs}</div><input type="number" min={10} max={32} value={fs} onChange={e => { const n = Math.max(10, Math.min(32, Number(e.target.value) || 14)); setFs(n); persist('fs', String(n)); }} />
        <div className="res"><label><input type="checkbox" style={chk} checked={minimap} onChange={e => { setMinimap(e.target.checked); persist('minimap', e.target.checked ? '1' : '0'); }} />Minimap</label></div>
        <div className="res"><label><input type="checkbox" style={chk} checked={wrap} onChange={e => { setWrap(e.target.checked); persist('wrap', e.target.checked ? '1' : '0'); }} />Word wrap</label></div>
        <div className="res" style={{ color: '#858585' }}>Shortcuts: Cmd+Enter run, Cmd+S save, Cmd+P go to file, Cmd+Shift+P commands, Cmd+Shift+F search, Cmd+F find, Cmd+H replace</div>
        <div className="res" style={{ color: '#858585' }}>Python runs in your browser (Pyodide). No server needed. pip packages: list them in requirements.txt (pure Python only).</div>
      </>}
    </div>
    <div className="ed">
      <div className="tabs">{open.map(p => <div key={p} className={'tab' + (p === active ? ' act' : '')} onClick={() => setActive(p)}>{p.split('/').pop()}{dirty.has(p) ? ' *' : ''} <span onClick={e => { e.stopPropagation(); closeTab(p); }}>x</span></div>)}</div>
      {active && <div className="crumb">{active.split('/').join(' > ')}</div>}
      {active && files[active] !== undefined ? <Editor theme="vs-dark" path={active} language={lang(active)} value={files[active]} onChange={edit}
        onMount={(e, m) => { ed.current = e; mon.current = m; registerPy(m); e.onDidChangeCursorPosition((ev: any) => setPos({ l: ev.position.lineNumber, c: ev.position.column })); }}
        options={{ fontSize: fs, minimap: { enabled: minimap }, automaticLayout: true, bracketPairColorization: { enabled: true }, guides: { indentation: true, bracketPairs: true }, tabSize: 4, insertSpaces: true, wordWrap: wrap ? 'on' : 'off', formatOnType: true, formatOnPaste: true, autoClosingBrackets: 'always', autoIndent: 'full', smoothScrolling: true, renderWhitespace: 'selection', scrollBeyondLastLine: false, suggest: { showSnippets: true, showWords: true }, quickSuggestions: { other: true, comments: false, strings: false } }} /> : <p style={{ padding: 20 }}>Open a file (Go to File: Cmd+P).</p>}
    </div>
    {showPv && <div className={'pv' + (full ? ' full' : '')}>
      <div style={{ display: 'flex', gap: 6, padding: 4, background: '#252526' }}><button onClick={() => setFull(!full)}>{full ? 'Exit full' : 'Fullscreen'}</button><span style={{ alignSelf: 'center', color: '#858585' }}>pygame preview</span></div>
      <iframe key={gameKey} title="game" sandbox="allow-scripts allow-modals" srcDoc={doc} allow="fullscreen; autoplay" />
    </div>}
    <div className="bot">
      <div className="tabs">
        <div className={'tab' + (tab === 'console' ? ' act' : '')} onClick={() => setTab('console')}>Console / Output</div>
        <div className={'tab' + (tab === 'errors' ? ' act' : '')} onClick={() => setTab('errors')}>Problems ({diags.length})</div>
        <div className={'tab' + (tab === 'input' ? ' act' : '')} onClick={() => setTab('input')}>Input (stdin)</div>
      </div>
      {tab === 'console' && <pre className="log">{log || 'Press Run. Output of print() appears here.'}</pre>}
      {tab === 'errors' && <pre className="log">{diags.map((d, i) => <div key={i} className="err" onClick={() => revealAt(Object.keys(files).find(f => f.endsWith(d.file)) || active, d.line, d.col)}>{d.file}:{d.line} {d.message}</div>)}</pre>}
      {tab === 'input' && <textarea value={stdin} onChange={e => setStdin(e.target.value)} placeholder={'Text for input(), one line per input() call'} style={{ flex: 1, margin: 8, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13 }} />}
    </div>
    <div className="stat">
      <span>{running ? 'Running...' : status} | problems {diags.length}</span>
      <span>Ln {pos.l}, Col {pos.c} | Spaces: 4 | UTF-8 | Python (Pyodide 0.26)</span>
    </div>
    {pal && <div className="ov" onClick={() => setPal(null)}><div className="pal" onClick={e => e.stopPropagation()}>
      <input autoFocus value={pal.text} placeholder="File name, or > for commands" onChange={e => setPal({ text: e.target.value, idx: 0 })}
        onKeyDown={e => { if (e.key === 'Escape') setPal(null); else if (e.key === 'Enter') runPal(pal.idx); else if (e.key === 'ArrowDown') { e.preventDefault(); setPal({ ...pal, idx: Math.min(palItems.length - 1, pal.idx + 1) }); } else if (e.key === 'ArrowUp') { e.preventDefault(); setPal({ ...pal, idx: Math.max(0, pal.idx - 1) }); } }} />
      <div style={{ maxHeight: '50vh', overflow: 'auto' }}>{palItems.map((it, i) => <div key={it.n} className={'pi' + (i === pal.idx ? ' sel' : '')} onClick={() => runPal(i)}>{it.n}</div>)}</div>
    </div></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
