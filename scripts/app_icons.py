"""Renders the PNG app icons (home screen, install dialog) and the social card from assets/logo.svg; requires local Playwright.

Run again after changing the logo: python scripts/app_icons.py
The same icons and logo are copied to the platform, so both apps look the same on a phone.
"""
import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
logo = (root / 'assets/logo.svg').read_text(encoding='utf-8')


def square(scale):
    # Full-bleed white background: phones cut their own shape (circle, squircle), so nothing important may sit near the edge.
    offset = 50 * (1 - scale)
    inner = logo.replace('<svg ', f'<svg x="{offset}" y="{offset}" width="{100 * scale}" height="{100 * scale}" ', 1)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/>{inner}</svg>'


icons = {
    'icon-192.png': (192, logo),                   # round logo, transparent corners
    'icon-512.png': (512, logo),
    'icon-maskable-512.png': (512, square(0.8)),   # ring inside the 80% safe circle
    'apple-touch-icon.png': (180, square(0.92)),   # iOS rounds the corners itself
}
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, (size, svg) in icons.items():
        page = browser.new_page(viewport={'width': size, 'height': size})
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}')
        page.screenshot(path=str(root / 'assets' / name), omit_background=True)
        page.close()
    page = browser.new_page(viewport={'width': 1200, 'height': 630})
    page.goto((root / 'scripts/social-card.html').as_uri())
    page.wait_for_load_state('networkidle')
    page.screenshot(path=str(root / 'assets/social-card.png'))
    browser.close()

for name in [*icons, 'logo.svg', 'favicon.svg']:
    shutil.copy(root / 'assets' / name, root / 'platform/public/assets' / name)
print('App icons and social card written to assets/; icons and logo copied to platform/public/assets/.')
