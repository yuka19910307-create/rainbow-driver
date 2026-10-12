/* Rainbow Driver Cargo: push-only service worker, isolated scope /cargo-pwa/.
 * This service worker does not cache navigation pages or affect driving-service routes.
 */
self.addEventListener("push",event=>{
  let payload={};
  try{if(event.data)payload=event.data.json()}catch(_){}
  const url="/cargo-pwa/driver.html";
  const data=payload&&typeof payload==="object"?payload:{};
  const title=typeof data.title==="string"?data.title.slice(0,90):"Rainbow Driver 軽貨物";
  const body=typeof data.body==="string"?data.body.slice(0,180):"軽貨物のテスト通知があります。";
  event.waitUntil(self.registration.showNotification(title,{
    body,
    icon:"/icon-192.png",
    badge:"/icon-192.png",
    tag:"rainbow-cargo-test",
    renotify:true,
    data:{url}
  }));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const dest=new URL("/cargo-pwa/driver.html",self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(async windows=>{
    for(const target of windows){
      try{
        const url=new URL(target.url);
        if(url.origin===self.location.origin&&url.pathname.startsWith("/cargo-pwa/")){
          await target.focus();
          return;
        }
      }catch(_){}
    }
    return self.clients.openWindow(dest);
  }));
});
