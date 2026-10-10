# WAN 实时流量历史与设备分时用量

## 设备每小时用量

历史分析页选择设备和日期，显示全天小时堆叠柱状图：绿色下载、橙色上传，柱高表示总量。悬浮、触摸点击、Tab 或方向键选择小时后，显示完整时段及下载、上传和总量；不再下钻到 5 分钟明细。手机上在图表内部横向滚动，整页不会随之溢出。首页上传/下载占比列表中的设备项可直接点击，打开历史分析并选中对应 MAC，定位到小时图；“其他设备”和“未归属”汇总项没有单设备入口。

日期和时段使用路由器本地时间，一般为 00:00–24:00；跨夏令时的本地日包含 23 或 25 个小时，同名时段附带 UTC 偏移。当前小时标注“统计中”，未来小时标注“尚未开始”，采集起点之前标注“未记录”，首个不完整小时标注“部分记录”。空柱表示没有已记录的流量，不能保证中断期间确实没有流量。

后台 R14、流量界面 R11 开始支持分时记录。记录来自现有 eBPF 设备互联网字节差值，局域网流量不计入。启动首次计数、时间未同步和超过 10 秒的采样中断不分配到某个时段。原有累计值和日/月汇总无法还原到具体时间，不做历史补录。

当前只保存 `device_usage_hour`，字段为 `mac/time/download/upload`，主键 `(mac,time)`。小时记录保留 30 天，只保存有流量的桶，每 5 分钟事务落盘（这是保存周期，不是用量粒度）；正常退出强制保存，突然断电可能丢失最后约 5 分钟。失败保留待写差值，提交成功后才清空，避免重试重复累加。升级启动时以事务删除旧 `device_usage_5m` 表和 `timeline_fine_floor` 设置，保留已有小时、日/月和累计记录。删除后的空闲页复用，不执行 VACUUM。

小时表最多 150,000 条记录，超额删除最早的完整小时桶；写盘失败时内存缓存最多 8,192 条。超过上限会缩短实际可查询范围，接口返回 `available_from`，页面提示部分记录或已过期。清空指定设备计数会同时删除其小时记录。

本地 SQLite 测试中，50 台设备持续活跃 30 天产生 36,000 条小时记录，文件约 2.52 MiB，原双粒度示例约 14.30 MiB。这不含日/月数据、WAN 实时速率记录或临时 WAL，行数上限不是数据库硬字节限制。

只读接口 `zen.traffic.getDeviceTimeline(mac,date)` 返回 JSON 字符串字段 `json`。MAC 必填，`date` 为路由器日期 `YYYY-MM-DD`。兼容旧客户端传入空 `hour`，非空 `hour` 已废弃并返回参数错误。结果包括 `start/end/step/since/now/available_from/expired/hourly_days` 和 `samples[{time,label,utc_offset,download,upload,recorded,available,partial,in_progress,future}]`；`step` 固定为 3600，未过期且已开始采集时补齐当天所有小时（最多 25 条），查询合并数据库和待写数据，不触发写盘。新界面兼容旧后台的稀疏小时记录；更老、不支持分时记录的后台提示升级。

验证命令：`python tools/test-device-timeline.py`、`node tools/test-device-timeline.cjs`、`node tools/test-device-timeline-browser.cjs`，以及 CI 中的 Rust 单元测试。浏览器测试使用本地只读样本。此版尚未在生产路由器安装验收。

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
