// Offline-only browser QA. Requires Playwright and Chromium supplied by the test environment.
const {chromium} = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const output = process.env.ADMIN_QA_OUTPUT || '/tmp/ramagan-admin-qa';
fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+req.url.split('?')[0]);
  if(!file.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
  fs.readFile(file,(err,body)=>{
    if(err){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
  });
});
function fixture(from,to){
  const day={date:from,subtotal_satang:20000,discount_satang:2950,total_satang:17050,sale_count:1,quantity_mg:1500};
  const daily=[];for(let date=from;date<=to;date=new Date(Date.parse(date)+86400000).toISOString().slice(0,10))daily.push(date===from?day:{date,subtotal_satang:0,discount_satang:0,total_satang:0,sale_count:0,quantity_mg:0});
  return {period:{from,to,timezone:'Asia/Bangkok'},capabilities:{discounts:true,discount_contract_version:1},summary:{...day,cash_satang:17050,transfer_satang:0,average_satang:17050},daily,top_products:[{...day,sku:'OFFLINE',name:'Synthetic QA only'}],top_categories:[{...day,category:'Offline fixture'}],recent_sales:[{...day,id:'offline-test-only',created_at:from+'T01:00:00Z',payment_method:'cash',line_count:1}],low_stock:[]};
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try{
    for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
      const page=await browser.newPage({viewport});
      let role='owner',mode='normal',reportRequests=0,release;
      const errors=[];page.on('pageerror',e=>errors.push(String(e)));
      await page.route('https://fixture.invalid/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/v1/auth/login')return route.fulfill({json:{token:'offline-test-token'}});
        if(url.pathname==='/v1/me')return route.fulfill({json:{role,store:{name:'OFFLINE SYNTHETIC QA',sales_enabled:false},capabilities:{discounts:true,discount_contract_version:1}}});
        if(url.pathname==='/v1/auth/logout')return route.fulfill({json:{ok:true}});
        if(url.pathname==='/v1/admin/sales-report'){
          reportRequests++;
          if(mode==='hold')await new Promise(r=>release=r);
          if(mode==='network')return route.abort();
          const data=fixture(url.searchParams.get('from'),url.searchParams.get('to'));
          if(mode==='legacy')data.capabilities={discounts:false};
          if(mode==='partial')delete data.daily[0].discount_satang;
          return route.fulfill({json:data});
        }
        throw Error('Unexpected API call '+url.pathname);
      });
      await page.goto('http://127.0.0.1:'+server.address().port+'/admin/index.html');
      async function login(){await page.fill('#api-base','https://fixture.invalid');await page.fill('#email','offline@example.invalid');await page.fill('#password','fixture-only');await page.click('#login-button');}
      await login();await page.waitForFunction(()=>document.querySelector('#metric-sales').textContent==='฿170.50');
      assert.equal(await page.textContent('#metric-discount'),'฿29.50');
      assert.equal(await page.textContent('#metric-gross'),'฿200.00');
      assert.equal(await page.locator('#top-products tr td').nth(3).textContent(),'฿170.50');
      assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:path.join(output,viewport.width+'-discount-report.png'),fullPage:true});
      mode='hold';await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#metric-sales').textContent==='—');
      assert.equal(await page.isDisabled('#export-csv'),true);
      await page.evaluate(()=>document.querySelector('#refresh').click());
      assert.equal(reportRequests,2);
      mode='network';release();await page.waitForFunction(()=>document.querySelector('#report-message').classList.contains('error'));
      assert.equal(await page.textContent('#metric-sales'),'—');
      mode='partial';await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#report-message').classList.contains('error')&&!document.body.classList.contains('busy'));
      assert.equal(await page.textContent('#metric-gross'),'—');
      mode='legacy';await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#discount-status').textContent.includes('ยังไม่ยืนยัน'));
      assert.equal(await page.textContent('#metric-sales'),'—');
      assert.equal(await page.textContent('#metric-discount'),'—');
      await page.screenshot({path:path.join(output,viewport.width+'-unsupported.png'),fullPage:true});
      await page.click('#logout');role='staff';await login();await page.waitForFunction(()=>document.querySelector('#login-message').textContent.includes('ไม่มีสิทธิ์'));
      assert.equal(await page.isVisible('#dashboard-panel'),false);
      role='manager';mode='normal';await login();await page.waitForFunction(()=>document.querySelector('#metric-sales').textContent==='฿170.50');
      await page.reload();assert.equal(await page.isVisible('#login-panel'),true);
      assert.equal(await page.textContent('#metric-sales'),'—');
      assert.deepEqual(errors,[]);await page.close();
    }
    console.log('PASS: desktop/mobile rendering, exact gross-discount-net, no overflow/storage, refresh clears stale values, repeated refresh, network/partial/legacy, owner/manager/staff, logout/reload. Offline fixtures only.');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
