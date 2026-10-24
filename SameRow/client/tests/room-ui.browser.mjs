import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
for (const candidate of [process.env.BROWSER_PACKAGE_DIR && `${process.env.BROWSER_PACKAGE_DIR}/playwright`, 'playwright', '/Users/pratyush/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'].filter(Boolean)) {
  try { ({ chromium } = require(candidate)); break; } catch { /* Optional local browser runtime. */ }
}
assert.ok(chromium, 'Install Playwright or set BROWSER_PACKAGE_DIR.');
const executablePath = process.env.BROWSER_EXECUTABLE || ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5175';
const artifactDir = process.env.UI_ARTIFACT_DIR || '/tmp/samerow-ui';
mkdirSync(artifactDir, { recursive: true });
const report = [];
try {
  for (const [width, height] of [[320,568],[390,844],[768,1024],[1024,768],[1440,900],[1920,1080],[844,390]]) {
    await page.setViewportSize({ width, height });
    for (const scene of ['alone','call','screen','youtube','jellyfin','multiple','buffering','error','reconnecting']) {
      await page.goto(`${base}/ui-preview?scene=${scene}&count=8`, {waitUntil:'domcontentloaded'});
      await page.locator('.room-shell').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const doc = document.documentElement;
        const toolbar = document.querySelector('.room-toolbar').getBoundingClientRect();
        const stage = document.querySelector('.room-composition').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.toolbar-controls button')].map(button => {
          const r=button.getBoundingClientRect();
          return { label:button.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clear:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button') === button };
        });
        return { width:doc.clientWidth,scrollWidth:doc.scrollWidth,scrollHeight:doc.scrollHeight,height:innerHeight,watching:document.querySelector('.room-shell').classList.contains('has-media'),toolbar:{y:toolbar.y,bottom:toolbar.bottom},stage:{height:stage.height,bottom:stage.bottom},controls };
      });
      assert.ok(layout.scrollWidth <= width+1, `${scene} ${width}: horizontal page overflow ${JSON.stringify(layout)}`);
      assert.ok(layout.scrollHeight <= height+1, `${scene} ${width}: page overflow vertically`);
      assert.ok(layout.stage.height >= 90, `${scene} ${width}: stage too short ${layout.stage.height}`);
      assert.ok(layout.stage.bottom <= (layout.watching ? height : layout.toolbar.y)+1, `${scene} ${width}: stage leaves available space`);
      for (const control of layout.controls) {
        assert.ok(control.width >=44 && control.height >=44, `${control.label}: touch target too small`);
        assert.ok(control.x>=0 && control.right<=width+1 && control.bottom<=height+1 && control.clear, `${scene} ${width}: inaccessible ${control.label}`);
      }
      report.push({scene,width,height,pass:true});
      if ((width===1440||width===390) && ['call','screen','youtube','alone'].includes(scene)) await page.screenshot({path:`${artifactDir}/${scene}-${width}.png`});
    }
    console.log(`PASS room state matrix at ${width}×${height}`);
  }
  for (const [width,height] of [[320,568],[390,844],[768,1024],[1440,900],[844,390]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${base}/ui-preview?scene=lobby`);
    await page.getByRole('heading',{name:'Join a room',exact:true}).waitFor();
    const fits = await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
    assert.ok(fits,`Lobby overflow at ${width}`);
    await page.getByLabel('Your name',{exact:true}).fill('  Alex Test  ');
    await page.getByLabel('Room code',{exact:true}).fill('invalid room');
    assert.ok(await page.getByRole('button',{name:'Enter room'}).isDisabled());
    await page.getByLabel('Room code',{exact:true}).fill('  plain-room  ');
    await page.getByRole('button',{name:'Enter room'}).click();
    await page.getByRole('heading',{name:'plain-room',exact:true}).waitFor();
    assert.ok(await page.getByText('Alex Test (You)',{exact:true}).isVisible());
    if(width===1440||width===390){await page.goto(`${base}/ui-preview?scene=lobby`);await page.locator('.lobby').waitFor();await page.screenshot({path:`${artifactDir}/lobby-${width}.png`,fullPage:true});}
  }
  console.log('PASS lobby sizing, room validation and trimmed names/codes at five viewports');
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`${base}/ui-preview?scene=multiple&count=4`);
  await page.locator('.media-tile').first().waitFor();
  await page.evaluate(() => { window.originalVideoNodes = [...document.querySelectorAll('.participant-grid video')]; window.originalMovie = document.querySelector('[data-preview-player]'); });
  await page.getByRole('button',{name:'YouTube',exact:true}).click();
  await page.getByRole('button',{name:'Everyone',exact:true}).click();
  await page.getByRole('button',{name:'Pin Jamie Chen',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Open chat',exact:true}).click();
  await page.getByRole('dialog',{name:'Room chat',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  const stable = await page.evaluate(() => window.originalVideoNodes.every((node,i)=>node===document.querySelectorAll('.participant-grid video')[i]) && window.originalMovie === document.querySelector('[data-preview-player]'));
  assert.ok(stable,'Layout/source/chat/resize changes remounted media elements');
  console.log('PASS media DOM identity across source changes, pinning, chat and resizing');
  await page.getByRole('button',{name:'Share something',exact:true}).click();
  await page.getByRole('dialog',{name:'Share with the room',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'More options',exact:true}).click();
  await page.getByRole('dialog',{name:'Room options',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS compact sharing and options dialogs');
  assert.deepEqual(errors,[],`Browser errors: ${errors.join('; ')}`);
  writeFileSync(`${artifactDir}/results.json`,JSON.stringify({checks:report.length,report,errors},null,2));
  console.log(`PASS ${report.length} viewport/state combinations; no browser errors`);
} finally { await browser.close(); }
