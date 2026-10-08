# WAN 实时流量历史与设备分时用量

## 设备分时用量

历史分析页选择设备和日期，显示该设备每天各小时的互联网下载、上传用量；点击小时可查看 5 分钟明细，返回按钮恢复小时视图。日期和时段使用路由器本地时间，跨夏令时的本地日可以包含 23 或 25 个小时。同名时段的提示包含 UTC 偏移。

后台 R14、流量界面 R11 开始支持此功能。原有累计值和日/月汇总无法还原到具体时间，不做历史补录。记录来自现有 eBPF 设备互联网字节差值，局域网流量不计入。启动首次计数、时间未同步和超过 10 秒的采样中断不分配到某个时段；空时段表示没有分时记录，不代表确定没有流量。

`device_usage_5m` 和 `device_usage_hour` 表分别保留 7 天、90 天，字段为 `mac/time/download/upload`，主键 `(mac,time)`。只保存有流量的桶，每 5 分钟事务落盘；正常退出强制保存，突然断电可能丢失最后约 5 分钟。失败保留待写差值，提交成功后才清空，因此正常重试和重启不会把已提交用量再次叠加。

每张表最多 150,000 条记录，超额删除最早的完整时间桶；写盘失败时每种粒度的内存缓存最多 8,192 条。超过上限会缩短实际可查询范围，接口返回 `available_from`，页面提示部分记录或已过期。不会删除每日、每月汇总；清空指定设备计数会同时删除其分时记录。

本地 SQLite 测试中，50 台设备持续活跃产生 208,800 条分时记录，文件约 14.30 MiB。这是新增分时记录的示例，不含长期日/月数据、其他实时速率记录和临时 WAL；记录上限控制行数，不是整个数据库的硬字节限制。删除后的空闲页会复用，文件不会立即缩小。

只读接口 `zen.traffic.getDeviceTimeline(mac,date,hour)` 返回 JSON 字符串字段 `json`。`date` 为路由器日期 `YYYY-MM-DD`；`hour` 空字符串查询当日小时桶，具体 Unix 秒查询该小时的 5 分钟桶。MAC 必填，日期和小时须合法。结果包括 `start/end/step/since/available_from/expired/detail_available_from` 和 `samples[{time,label,utc_offset,download,upload}]`，每次最多 400 条，合并已落盘与待写数据且不触发写盘。老后台界面提示升级，不发不支持的 RPC。

验证命令：`python tools/test-device-timeline.py`、`node tools/test-device-timeline.cjs`，以及 CI 中的 Rust 单元测试。此功能尚未在生产路由器安装验收。

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
