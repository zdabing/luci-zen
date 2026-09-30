# WAN 实时流量历史

入口：状态 → Zen 流量 → 实时流量历史。

daemon 每 5 秒根据默认路由上游接口的字节计数差分记录下载、上传速率，
不依赖浏览器是否打开。只记录上游接口，多个上游按接口分别保存；
记录实际设备名，例如 `pppoe-wan`。计数器重置或接口消失时跳过该区间，
不会用负差分制造速率。时钟未同步时不保存实时历史。

## 保存和保留

SQLite 表 `realtime_usage`：

| 字段 | 含义 |
| --- | --- |
| interface | 实际 WAN 接口名 |
| timestamp | Unix 秒 |
| download_rate | 下载字节/秒 |
| upload_rate | 上传字节/秒 |

主键 `(interface, timestamp)` 保证重试写入不会重复；时间索引用于清理。
每 5 分钟批量事务落盘，同时删除 7 天前的实时记录。
正常退出前落盘，突然断电可能丢失最后约 5 分钟未保存的记录。
写入失败会保留缓存，每 5 分钟重试；缓存最多 120,960 条，达到上限时
丢弃最早的未落盘记录并记录日志。日/月汇总清理不影响此表。

## 查询接口

`zen.traffic.getRealtimeHistory` 的参数：

| 参数 | 含义 |
| --- | --- |
| iface | 实际接口名；空字符串默认当前上游 |
| start / end | 查询起止时间，Unix 秒；默认最近 5 分钟 |
| limit | 最大返回点数，2–1200，默认 600 |

返回 `interface`、可选 `interfaces`、实际 `start` / `end`、分组秒数 `step`、
`retention_days: 7`、`sample_seconds: 5` 和
`samples: [{time, download, upload}]`。

长范围按时间分组计算平均速率；分页表显示的是同一组查询结果。
查询合并 SQLite 和未落盘的内存记录，不触发写盘。
缺失区间不补零；查询页不跨采集间隙连接曲线。
页面日期使用浏览器本地时区。首页读取当前 WAN 最近约 5 分钟记录，
老版本 daemon 不支持此接口时继续使用浏览器实时采样。

## 无编译检查

```text
python tools/test-realtime-history.py
python tools/test-sqlite-retention.py
node tools/test-dashboard-history.cjs
node tools/check-po.js luci-app-zen-traffic
node tools/check-po.js luci-theme-zen
```

这些检查覆盖 SQLite 语句、保留边界、聚合、查询隔离、首页恢复与翻译。
它们不替代 Rust 类型检查、链接验证和 OpenWrt 真机验收。
