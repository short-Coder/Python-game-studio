# Python Game Studio
Browser IDE for Python (Monaco editor). Python runs in the browser with Pyodide (WebAssembly): no backend, no API key.
- Console programs run in a Web Worker (Stop button really stops them).
- pygame programs run in a sandboxed iframe (pygame-ce). Game loops must contain `await asyncio.sleep(0)`.
- Multiple files / folders, imports between files, requirements.txt (pure-Python packages via micropip), ZIP import/export, autosave (IndexedDB).
Deploy: GitHub + Vercel (Framework: Vite, no environment variables).
