const CACHE='securityops-mobile-v1';
const SHELL=['/','/mobile','/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(fetch(event.request).catch(()=>caches.match(event.request).then(response=>response||caches.match('/'))));
});
self.addEventListener('push',event=>{
  const data=event.data?.json()||{title:'SecurityOps',body:'Neue Benachrichtigung'};
  event.waitUntil(self.registration.showNotification(data.title,{body:data.body,data:data.url||'/mobile'}));
});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.openWindow(event.notification.data||'/mobile'));});
