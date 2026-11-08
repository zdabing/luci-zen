'use strict';
'require baseclass';

// Explicit mappings only: labels and custom rule names are not asset paths.
const BRANDS = {
 apple:'Apple',xiaomi:'Xiaomi',huawei:'Huawei',samsung:'Samsung',oppo:'OPPO',
 vivo:'Vivo',honor:'Honor',oneplus:'OnePlus',lenovo:'Lenovo',motorola:'Motorola',
 google:'Google',synology:'Synology',qnap:'QNAP'
};
const IDS = {
 48:'QQ',49:'TikTok',54:'iQIYI',120:'Twitter',197:'WeChat',285:'Tencent',
 65537:'Youku',65538:'Bilibili',65540:'Douyin',65541:'Kuaishou',65542:'Douyu',
 65543:'Huya',1048577:'TencentCloud',1048578:'Aliyun'
};
const NAMES = {
 wechat:'WeChat',bilibili:'Bilibili',iqiyi:'iQIYI',youku:'Youku',douyin:'Douyin',
 kuaishou:'Kuaishou',douyu:'Douyu',huya:'Huya',tiktok:'TikTok',qq:'QQ',
 twitter:'Twitter',tencent:'Tencent',tencentcloud:'TencentCloud',
 alibabacloud:'Aliyun',aliyun:'Aliyun',cloudflare:'Cloudflare',akamai:'Akamai',
 microsoftazure:'Azure',amazonaws:'Amazon',youtube:'YouTube',netflix:'Netflix',
 steam:'Steam',telegram:'Telegram',github:'GitHub'
};
const ASSETS = new Set([...Object.values(BRANDS),...Object.values(IDS),...Object.values(NAMES)]);

function image(name,size,onError) {
 if(!ASSETS.has(name))return null;
 const pixels=Math.max(16,Math.min(48,Number(size)||24));
 return E('img',{
  class:'zen-brand-art',src:L.resource('view/zen/icons/qure/'+name+'.svg'),
  width:pixels,height:pixels,alt:'','aria-hidden':'true',decoding:'async',
  error:function(){if(onError)onError();else this.hidden=true;}
 });
}

return baseclass.extend({
 image,
 brand(name,size,onError){return image(BRANDS[name],size,onError);},
 application(app,size){
  // Recognition gaps and transport protocols have no application brand.
  if(app.kind==='protocol'||app.identified===false&&app.kind!=='infrastructure')return null;
  return image(IDS[app.id]||NAMES[String(app.name||'').toLowerCase()],size);
 }
});
