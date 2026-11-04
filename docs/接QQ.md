# 接 QQ（可选）

## 一、默认不支持、默认关闭

装完**不能直接连 QQ**，这是故意的：接 QQ 要账号、有风控，不该是默认形态。
`config.json` 里：

```json
{
  "qq": { "enabled": false, "gateway": "", "token": "", "allow": [], "groups": [], "self_id": "" }
}
```

- `enabled` 不是 `true`，`/api/qq/incoming` 一律返回 `{ok:false, ignored:true, reason:"qq disabled"}`；
- `allow` 为空 = 没有任何私聊被处理；`groups` 为空 = 没有任何群被处理。

## 二、想接怎么做

1. **起一个 OneBot 类网关**（SnowLuma / NapCat / go-cqhttp 那类都行），记下它的 HTTP 地址和 access_token。
2. **填配置**（软件版「设置 → QQ 桥接」也可以填，或直接改 `config.json`）：

   ```json
   {
     "qq": {
       "enabled": true,
       "gateway": "http://127.0.0.1:5700",
       "token": "你的网关令牌",
       "allow": ["你的QQ号"],
       "groups": ["允许的群号"],
       "self_id": "机器人QQ号"
     }
   }
   ```

3. **网关把消息转进来**，拿返回的 `reply` 回去发（被动模式，推荐）：

   ```
   POST http://127.0.0.1:7889/api/qq/incoming
   { "post_type":"message", "message_type":"private", "user_id":123, "raw_message":"在吗" }
   → { "ok":true, "reply":"在呢。" }
   ```

   - 私聊：`user_id` 必须在 `allow` 里；
   - 群聊：`group_id` 必须在 `groups` 里，且消息里 **@ 她或点名（「鲸倩」「小鲸」「@鲸倩」）** 才回，不然不理。
   - 每条 QQ 消息只触发**这个人/这个群自己的会话**（`qq-p<QQ号>` / `qq-g<群号>`），不会串到别人的历史里。
   - 群里出现「删/格式化/格盘/授权/提权/改密码」这类词，**直接回固定话术，不进模型**。

4. **也可以主动发**（出方向）：

   ```
   POST http://127.0.0.1:7889/api/qq/send
   { "to":123, "text":"到点了，喝水" }               // 私聊
   { "to":456789, "text":"大家好", "group":true }    // 群
   ```

   服务会带 `Authorization: Bearer <token>` 调网关的 `/send_private_msg` 或 `/send_group_msg`。

5. **审计**：每条收发都写 `data/qq.log`（时间、方向、对方、长度、40 字摘要），不记完整长文本。

## 三、OneBot WS 直连（SnowLuma / NapCat / LLOneBot 都行）

除了 HTTP 推送，软件也能当 OneBot WS 客户端：网关主动推事件，软件连上去收。

```json
"qq": {
  "enabled": true,
  "kind": "onebot-ws",
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": "网关的 access token",
  "dryRun": true,
  "allow": ["你的QQ号"],
  "groups": []
}
```

- `kind`：`onebot-http`（默认，原来的 HTTP 推送）或 `onebot-ws`（本机推荐 SnowLuma 就用这个）
- `dryRun`：先设 `true` 只记录收到什么、不自动回，验证通了再改 `false`
- 日志在 `data/qq-onebot-ws.log`（收到/断开/重连）和 `data/qq.log`（入/出）
- 发送还是走 `httpUrl` 的 OneBot HTTP 动作（`/send_private_msg`、`/send_group_msg`），令牌用 `accessToken`

**同一台机器别让两个桥同时回同一个号**：DSH 自带 QQ 桥 + 软件桥都连着，同一条消息会收到两份回复，二选一。

## 四、风险与限制

- **账号可能被风控**：QQ 对第三方机器人不友好，轻则限流，重则封号；
- **别拿主号试**：用小号；出问题最多是小号掉线；
- **需要常驻进程**：网关要一直开着，掉线要重连；
- **别把端口暴露到公网**：7889 默认只听 `127.0.0.1`，没有鉴权，只给本机网关用；
- **群里会带上说话人**：适配层把群友的昵称/名片当成 speaker 传进来，群友说「我…」按他名字存、挂他名下，不会写成主人的事；私聊白名单里的号视为主人。
- **群聊只用模拟环境验证过**：作者没有真实 QQ 群的数据，群聊能力靠假模型 + 临时服务验（`evals/group-test.js`）。真要用请自备白名单群和桥接，自行验证；群里仍然必须 @/点名才回，不刷屏。
- **命令仍走红线**：QQ 来的人最多只能聊天和触发普通工具，P0 直接拒、P1/P2 要确认，确认不了的不会执行；
- 这层只做协议适配，不做风控绕过、不做多账号、不自动同意好友。

## 五、一键连接（不用手填令牌）

软件版「设置 → QQ 一键连接」：

1. 点「自动找 QQ 桥接」→ 服务会扫本机常见 OneBot 端口（3000/5700/6700/8080/18080/18700）探 /get_login_info，先试已存令牌再试不带令牌；
2. 找到就显示「找到了：昵称（账号 xxx）」，点「连接」→ 验证通过才写 config.json 的 qq.enabled=true 并保存 gateway/token/selfId；
3. 连上显示绿点「已连接」，「断开」把 qq.enabled 改回 false；
4. 没找到会给一句人话（装什么、装好点重新检测），端口/令牌默认藏起来，勾「高级」才显示。

对应接口：GET /api/qq/discover、POST /api/qq/connect {gateway?,token?}、POST /api/qq/disconnect。
任何情况下默认仍是关闭，必须用户点了才会开。
