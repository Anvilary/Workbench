import {createServer} from 'node:http';
import {existsSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {fixture,html} from './pane-interactions-fixture.mjs';

export const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../../../../..');
export async function serveFixture(t){
 const bundle=await build({stdin:{contents:fixture,loader:'tsx',resolveDir:path.join(root,'packages/web')},bundle:true,write:false,outdir:'/tmp/maw-interaction-bundle',format:'esm',jsx:'automatic',logLevel:'silent'});
 const server=createServer((req,res)=>{const name=req.url?.split('?')[0];res.setHeader('Content-Type',name==='/bundle.js'?'text/javascript':name==='/bundle.css'?'text/css':'text/html');res.end(name?.startsWith('/bundle.')?bundle.outputFiles.find(file=>file.path.endsWith(name==='/bundle.css'?'.css':'.js')).text:html)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return 'http://127.0.0.1:'+server.address().port;
}
export function executable(){
 if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
 if(existsSync(chromium.executablePath()))return chromium.executablePath();
 const cache=homedir()+'/.cache/ms-playwright';
 for(const folder of existsSync(cache)?readdirSync(cache).filter(n=>n.startsWith('chromium_headless_shell-')).sort().reverse():[]){const file=cache+'/'+folder+'/chrome-headless-shell-linux64/chrome-headless-shell';if(existsSync(file))return file}
 throw new Error('Chromium is required');
}
export async function setup(t,query='',viewport={width:1280,height:860}){
 const url=await serveFixture(t);const browser=await chromium.launch({headless:true,executablePath:executable()});t.after(()=>browser.close());
 const page=await browser.newPage({viewport});await start(page,url+'/?'+query);return page;
}
export async function start(page,url){
 page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);await page.locator('#start').click();await page.waitForSelector('.maw-split-pane');await frames(page);return errors;
}
export const frames=(page,count=5)=>page.evaluate(async count=>{for(let n=0;n<count;n++)await new Promise(resolve=>requestAnimationFrame(resolve))},count);
export const pane=(page,n)=>page.locator('#pane-container-pane-'+n);
export const order=page=>page.locator('.maw-split-pane').evaluateAll(nodes=>nodes.map(node=>node.id.replace('pane-container-','')));
export async function drag(page,from,to,{cancel=false,outside=false}={}){
 const source=await pane(page,from).locator('.maw-pane-grip').boundingBox();const target=await pane(page,to).boundingBox();
 await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();
 await page.mouse.move(source.x+source.width/2+12,source.y+source.height/2,{steps:4});
 await page.waitForSelector('.maw-pane-drag-shield');
 await page.mouse.move(outside?3:target.x+target.width/2,outside?3:target.y+target.height/2,{steps:16});
 await frames(page);if(cancel)await page.keyboard.press('Escape');await page.mouse.up();await frames(page,16);
}
