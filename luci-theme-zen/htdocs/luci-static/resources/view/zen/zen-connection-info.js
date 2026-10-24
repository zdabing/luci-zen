'use strict';
'require baseclass';

const number=value=>value!=null&&Number.isFinite(Number(value))?Number(value):null;
function speed(value){value=number(value);return value>0?(value>=1000?(value/1000).toLocaleString(undefined,{maximumFractionDigits:2})+' Gbps':value.toLocaleString(undefined,{maximumFractionDigits:1})+' Mbps'):null;}
function duration(value){value=number(value);if(value==null||value<0)return null;const minutes=Math.floor(value/60),hours=Math.floor(minutes/60),days=Math.floor(hours/24);return days?_('%dd %dh').format(days,hours%24):hours?_('%dh %dm').format(hours,minutes%60):_('%dm').format(minutes);}
function merge(device,metadata,receivedAt){
 if(!metadata||Date.now()-receivedAt>45000)return device;
 if(metadata.kind==='wifi')return {...device,conn:'wifi',online:true,band:metadata.band||device.band,signal_dbm:metadata.signal_dbm,
  connected_seconds:number(metadata.connected_seconds)==null?null:Number(metadata.connected_seconds)+Math.floor(Math.max(0,Date.now()-receivedAt)/1000),
  link_upload_mbps:metadata.upload_mbps,link_download_mbps:metadata.download_mbps};
 return {...device,port:metadata.port,port_speed_mbps:metadata.port_speed_mbps};
}
function connection(device){
 if(device.conn==='wifi')return [_('Wi-Fi'),device.band,number(device.signal_dbm)<0?device.signal_dbm+' dBm':null].filter(Boolean).join(' · ');
 if(device.conn==='wired')return [_('Wired'),device.port,speed(device.port_speed_mbps)].filter(Boolean).join(' · ');
 return device.conn==='router'?_('Router'):device.conn||'';
}
function status(device){
 if(!device.online){
  if(!(device.last>0))return _('Offline');
  const date=new Date(device.last*1000),today=new Date(Date.now()),yesterday=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1),clock=date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',hour12:false});
  const day=date.toDateString()===today.toDateString()?_('Today'):date.toDateString()===yesterday.toDateString()?_('Yesterday'):date.toLocaleDateString();
  return _('Last active %s').format(day+' '+clock);
 }
 const elapsed=duration(device.connected_seconds);return elapsed?_('Connected %s').format(elapsed):_('Online');
}
function linkRate(device){if(device.conn==='wifi'){const up=speed(device.link_upload_mbps),down=speed(device.link_download_mbps);return up||down?('↑ '+(up||'—')+' · ↓ '+(down||'—')):null;}return speed(device.port_speed_mbps);}
return baseclass.extend({merge,connection,status,duration,linkRate});
