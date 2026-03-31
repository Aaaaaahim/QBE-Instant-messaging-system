# QBE 即时通讯软件

QBE 是一款基于 B/S 架构的轻量级即时通讯系统，后端使用 C++ 编写，前端为纯 HTML/CSS/JS，无需任何前端框架或 Node.js。

---

## 目录

- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [功能特性](#功能特性)
- [REST API 接口](#rest-api-接口)
- [构建与运行](#构建与运行)
- [数据库配置](#数据库配置)
- [WebRTC 音视频通话配置](#webrtc-音视频通话配置)
- [前端页面说明](#前端页面说明)
- [注意事项](#注意事项)

---

## 项目概述

QBE 采用经典的 B/S（浏览器/服务器）架构：

- **后端**：单可执行文件，内嵌 Mongoose HTTP 服务器，使用线程池处理并发请求。
- **前端**：静态 HTML/CSS/JS 文件，由后端直接伺服，无需 Nginx/Apache。
- **通信**：客户端通过短轮询（/api/poll_events）接收实时事件（消息、好友请求、RTC 信令）。
- **音视频**：通过 WebRTC + 服务端 TURN 中继实现点对点音视频通话。

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 后端语言 | C++17 |
| HTTP 框架 | Mongoose（单头文件嵌入） |
| 并发模型 | 自定义线程池 (ThreadPool) |
| 数据存储 | TSV 文件（默认）/ MySQL（可选） |
| 密码安全 | 随机 Salt + SHA 哈希 |
| 前端语言 | HTML5 / CSS3 / Vanilla JS |
| 字体 | Manrope（Google Fonts） |
| 图标 | Font Awesome 6 |
| 音视频 | WebRTC（RTCPeerConnection） |
| TURN 服务 | coturn |

---

## 项目结构

`	ext
BS_web_connect/
|-- main.cpp                  # HTTP 服务器主程序，事件循环，静态文件服务
|-- sql.cpp / sql.h           # 用户数据库、全部 API 实现、内存事件队列
|-- threadpool.cpp / .h       # 线程池（单例）
|-- mongoose.c / .h           # Mongoose 嵌入式 HTTP 库
|-- user_db.tsv               # TSV 格式用户数据库（File 模式使用）
|-- TURN_SETUP.txt            # TURN 服务器配置说明
|-- BS_web_connect.vcxproj    # Visual Studio 项目文件
-- web_root/                 # 前端静态资源
    |-- login.html            # 登录 / 注册页
    |-- client_connect.html   # 聊天主界面
    |-- client_connect.js     # 聊天核心逻辑
    |-- client_connect.css    # 聊天界面样式
    |-- client.html           # 个人资料 / 设置页
    |-- web.html              # 落地页 / 导航页
    |-- qbe_cursor.css/js     # 可选：自定义光标特效
    |-- qbe_ocean.css/js      # 可选：海洋动态背景特效
    -- uploads/              # 用户上传文件存储目录
`

---

## 功能特性

### 账户系统
- 邮箱 + 密码注册与登录，Salt + SHA 哈希存储
- 登录记录 IP 与端口，支持自定义在线状态

### 好友系统
- UID 搜索、好友申请/接收/拒绝、删除好友

### 即时消息
- 单聊与群聊、未读计数、消息置顶、静音、草稿保存
- 浏览器桌面通知、提示音、联系人搜索

### 文件传输
- 支持单次 Base64 上传与分片上传，支持取消上传

### 音视频通话（WebRTC）
- 点对点音视频，服务端 SDP/ICE 中继
- 支持 TURN 免 NAT 穿透场景，信令 TTL 机制

### UI 与体验
- 响应式布局、侧边栏折叠、动效支持

---

## REST API 接口

所有接口为 POST /api/，Content-Type: application/json。
包含：register, login, get_user, update_status, add_friend, friend_response, remove_friend, send_message, create_group, send_group_message, poll_events, upload, upload_chunk, upload_cancel, rtc_config, rtc_offer, rtc_answer, rtc_ice, rtc_hangup。

---

## 构建与运行

### Windows (Visual Studio)
1. 打开 BS_web_connect.slnx
2. 选择 x64 配置并生成

### Linux 编译
`ash
g++ -std=c++17 -O2 -pthread main.cpp sql.cpp threadpool.cpp mongoose.c -o qbe_server
./qbe_server
`

---

## 数据库配置

默认 TSV 模式（user_db.tsv），可在 main.cpp 中切换为 MySQL 后端。

---

## WebRTC 配置

安装 coturn，配置 /etc/turnserver.conf，并在服务端设置 QBE_TURN_* 环境变量。

---

## 注意事项
- 路径硬编码在 main.cpp，移植建议改为相对路径。
- 文件上传直接存入 uploads 目录，需定期清理。
