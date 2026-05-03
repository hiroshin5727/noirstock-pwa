const CACHE_NAME='noirstock-v6.4.1';
const ASSETS=[
 './',
 './index.html',
 './manifest.webmanifest',
 './assets/icon-192.png',
 './assets/icon-512.png',
 './assets/apple-touch-icon.png',
 './src/styles.css',
 './src/app.js',
 './src/schema.js',
 './src/db.js',
 './src/utils.js',
 './src/compat.js',
 './src/validator.js',
 './src/calc.js',
 './src/handmade.js',
 './src/taxMode.js',
 './src/listing.js',
 './src/analytics.js'
];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE_NAME)await caches.delete(k);await self.clients.claim()})())});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith((async()=>{const c=await caches.match(e.request);if(c)return c;try{const r=await fetch(e.request);(await caches.open(CACHE_NAME)).put(e.request,r.clone());return r}catch(err){return c||Response.error()}})())});
