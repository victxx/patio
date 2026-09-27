"""Inline fonts and background into src/landing.src.html -> index.html (one self-contained file)."""
import base64, pathlib
root = pathlib.Path(__file__).resolve().parent
b = lambda p: base64.b64encode((root / 'assets' / p).read_bytes()).decode()
s = (root / 'src' / 'landing.src.html').read_text()
for k, f in {'FONT_TG': 'terminal-grotesque.ttf', 'FONT_PX': 'geist-pixel-square.woff2',
             'FONT_PXG': 'geist-pixel-grid.woff2', 'BG': 'bg-small.jpg'}.items():
    s = s.replace('{{%s}}' % k, b(f))
(root / 'index.html').write_text(s)
web_landing = root.parent / 'web' / 'public' / 'landing'
web_landing.mkdir(parents=True, exist_ok=True)
(web_landing / 'index.html').write_text(s)
print(len(s) // 1024, 'KB')
