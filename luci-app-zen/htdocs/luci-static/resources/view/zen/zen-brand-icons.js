'use strict';
'require baseclass';

// Explicit mappings only: labels and custom rule names are not asset paths.
const BRANDS = {
 apple:'Apple',xiaomi:'Xiaomi',huawei:'Huawei',samsung:'Samsung',oppo:'OPPO',
 vivo:'Vivo',honor:'Honor',oneplus:'OnePlus',lenovo:'Lenovo',motorola:'Motorola',
 google:'Google',synology:'Synology',qnap:'QNAP'
};
const IDS = {
 48:'QQ',49:'TikTok',54:'iQIYI',120:'Twitter',197:'WeChat',285:'Tencent',324:'Tencent',395:'Tencent',
 65537:'Youku',65538:'Bilibili',65540:'Douyin',65541:'Kuaishou',65542:'Douyu',
 65543:'Huya',65547:'Aliyun',65549:'Aliyun',65556:'OPPO',65557:'Xiaomi',
 65565:'Tencent',65566:'QQ',65572:'Huawei',65573:'Honor',65574:'Vivo',
 65575:'Synology',65584:'QNAP',1048577:'TencentCloud',1048578:'Aliyun'
};
const NAMES = {
 wechat:'WeChat',bilibili:'Bilibili',iqiyi:'iQIYI',youku:'Youku',douyin:'Douyin',
 kuaishou:'Kuaishou',douyu:'Douyu',huya:'Huya',tiktok:'TikTok',qq:'QQ',
 twitter:'Twitter',tencent:'Tencent',tencentcloud:'TencentCloud',
 alibabacloud:'Aliyun',aliyun:'Aliyun',cloudflare:'Cloudflare',akamai:'Akamai',
 microsoftazure:'Azure',amazonaws:'Amazon',youtube:'YouTube',netflix:'Netflix',
 steam:'Steam',telegram:'Telegram',github:'GitHub',google:'Google'
};
const DOMAIN_ICONS = {
 'google.com':'Google','googleapis.com':'Google','googlevideo.com':'YouTube','gstatic.com':'Google',
 'youtube.com':'YouTube','ytimg.com':'YouTube','github.com':'GitHub','githubusercontent.com':'GitHub',
 'apple.com':'Apple','icloud.com':'Apple','mzstatic.com':'Apple',
 'bilibili.com':'Bilibili','bilivideo.com':'Bilibili','hdslb.com':'Bilibili',
 'douyin.com':'Douyin','douyinvod.com':'Douyin','douyinpic.com':'Douyin','tiktok.com':'TikTok',
 'kuaishou.com':'Kuaishou','iqiyi.com':'iQIYI','iqiyipic.com':'iQIYI','youku.com':'Youku',
 'qq.com':'QQ','wechat.com':'WeChat','weixin.qq.com':'WeChat','tencent.com':'Tencent',
 'aliyuncs.com':'Aliyun','aliyun.com':'Aliyun','taobao.com':'Aliyun',
 'cloudflare.com':'Cloudflare','cloudflare.net':'Cloudflare','amazonaws.com':'Amazon',
 'xiaomi.com':'Xiaomi','mi.com':'Xiaomi','huawei.com':'Huawei',
 'netflix.com':'Netflix','steampowered.com':'Steam','telegram.org':'Telegram',
 'x.com':'Twitter','twitter.com':'Twitter','douyu.com':'Douyu','huya.com':'Huya',
 'synology.com':'Synology','qnap.com':'QNAP'
};
const ASSETS = new Set([...Object.values(BRANDS),...Object.values(IDS),...Object.values(NAMES),...Object.values(DOMAIN_ICONS)]);

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
 },
 domain(rootDomain,appId,appName,size){
  const key=String(rootDomain||'').toLowerCase();
  const matched=DOMAIN_ICONS[key]||IDS[appId]||NAMES[String(appName||'').toLowerCase()];
  return image(matched,size);
 }
});
