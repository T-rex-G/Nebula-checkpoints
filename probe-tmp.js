const { chromium } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./test/e2e/public-alpha-fixtures');
(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium',
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  for (const vp of [{width:390,height:820,tag:'mobile'},{width:1440,height:900,tag:'desktop'}]) {
    const ctx = await browser.newContext({ viewport:vp, baseURL:'http://127.0.0.1:21999', serviceWorkers:'block' });
    const page = await ctx.newPage();
    await mockPublicAlphaApi(page, { access:'active', repositoryState:'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor({timeout:20000});
    await page.waitForTimeout(3500);
    const r = await page.evaluate(() => {
      const panes = [...document.querySelectorAll('.tabpane')].map(p => {
        const b = p.getBoundingClientRect();
        return { id:p.id, cls:p.className, disp:getComputedStyle(p).display,
                 top:Math.round(b.top), h:Math.round(b.height) };
      }).filter(p => p.disp !== 'none' || p.cls.includes('active'));
      const ee = document.querySelector('#editorEmpty');
      return { panes, editorEmptyHidden: ee ? ee.hidden : 'missing',
        editorEmptyDisp: ee ? getComputedStyle(ee).display : null,
        editorShellHidden: document.querySelector('#editorShell')?.hidden,
        mainPaneH: Math.round(document.querySelector('.main-pane').getBoundingClientRect().height) };
    });
    console.log(vp.tag, JSON.stringify(r,null,1));
    await ctx.close();
  }
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
