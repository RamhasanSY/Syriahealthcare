"""Renders the PNG app icons (home screen, install dialog) from assets/logo.svg; requires local Playwright.

Run again after changing the logo: python scripts/app_icons.py
The same icons are copied to the platform, so both apps look the same on a phone.
"""
import re
import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
logo = (root / 'assets/logo.svg').read_text(encoding='utf-8')
artwork = re.sub(r'<rect[^>]*/>', '', re.sub(r'<title>.*?</title>', '', logo.split('>', 1)[1].rsplit('</svg>', 1)[0]))


def square(scale):
    # Full-bleed background: phones cut their own shape (circle, squircle), so nothing important may sit near the edge.
    offset = 44 * (1 - scale)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88"><rect width="88" height="88" fill="#173e36"/>'
            f'<g transform="translate({offset} {offset}) scale({scale})">{artwork}</g></svg>')


icons = {
    'icon-192.png': (192, logo),            # rounded logo, transparent corners
    'icon-512.png': (512, logo),
    'icon-maskable-512.png': (512, square(0.82)),  # artwork inside the 80% safe circle
    'apple-touch-icon.png': (180, square(1)),      # iOS rounds the corners itself
}
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, (size, svg) in icons.items():
        page = browser.new_page(viewport={'width': size, 'height': size})
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}')
        page.screenshot(path=str(root / 'assets' / name), omit_background=True)
        shutil.copy(root / 'assets' / name, root / 'platform/public/assets' / name)
        page.close()
    browser.close()
print('App icons written to assets/ and platform/public/assets/.')
